import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { createAndroidPhoneText } from '../src/android-phone-text.js';

const cfg = { adbPath: 'C:/fixed/adb.exe', serial: 'OFFLINE_TEST_DEVICE', scrcpyServerPath: 'D:/fixed/scrcpy-server' };
const cases = [];
const test = (name, run) => cases.push({ name, run });
const ack = sequence => { const b = Buffer.alloc(9); b[0] = 1; b.writeBigUInt64BE(sequence, 1); return b; };
const clipboard = text => { const bytes = Buffer.from(text); const b = Buffer.alloc(5 + bytes.length); b.writeUInt32BE(bytes.length, 1); bytes.copy(b, 5); return b; };
async function fixture(options = {}) {
  const calls = [], messages = [], sockets = new Set();
  let current = { ...cfg }, clip = '', finishServer, serverStarts = 0, maxServers = 0, liveServers = 0;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); finishServer?.(); });
    let buffer = Buffer.alloc(0);
    socket.write(Buffer.from([options.badDummy ? 7 : 0]));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (buffer[0] === 9) {
          if (buffer.length < 14) return;
          const size = buffer.readUInt32BE(10); if (buffer.length < 14 + size) return;
          const sequence = buffer.readBigUInt64BE(1), paste = buffer[9], text = buffer.toString('utf8', 14, 14 + size);
          buffer = buffer.subarray(14 + size); clip = text; messages.push({ sequence, paste, text });
          if (options.changeConfigOnSet) current = { ...current, serial: 'OTHER' };
          if (options.disconnectOnPaste && paste) { socket.destroy(); return; }
          if (options.noAck || (options.noPasteAck && paste)) continue;
          const packet = ack(options.wrongAck ? sequence + 1n : sequence);
          if (options.fragment) { socket.write(packet.subarray(0, 3)); setTimeout(() => !socket.destroyed && socket.write(packet.subarray(3)), 3); }
          else socket.write(packet);
        } else if (buffer[0] === 8) {
          if (buffer.length < 2) return;
          assert.equal(buffer[1], 0, 'never copy/cut app contents'); buffer = buffer.subarray(2);
          const packet = clipboard(options.mismatch ? 'not the requested clipboard' : clip);
          if (options.oversize) packet.writeUInt32BE(0xffffffff, 1);
          if (options.fragment) { socket.write(packet.subarray(0, 4)); setTimeout(() => !socket.destroyed && socket.write(packet.subarray(4)), 3); }
          else socket.write(packet);
        } else throw new Error(`Unexpected control type ${buffer[0]}`);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  function execFile(file, args, opts, cb) {
    calls.push({ file, args, opts });
    assert.equal(opts.shell, false); assert.equal(opts.windowsHide, true);
    assert.deepEqual(args.slice(0, 2), ['-s', cfg.serial]);
    const a = args.slice(2);
    let called = false;
    const finish = (error = null, out = '') => { if (!called) { called = true; cb(error, out, ''); } };
    const child = new EventEmitter();
    child.kill = () => { finish(); return true; };
    if (a.includes('com.genymobile.scrcpy.Server')) {
      serverStarts++; liveServers++; maxServers = Math.max(maxServers, liveServers);
      finishServer = () => { if (!called) liveServers--; finish(); };
      if (options.crash) queueMicrotask(() => finishServer());
    } else queueMicrotask(() => {
      if (a[0] === 'get-state') finish(null, options.offline ? 'offline\n' : 'device\n');
      else if (a[0] === 'push' && options.pushFails) finish(new Error('raw secret device error'));
      else if (a[0] === 'forward' && a[1] === 'tcp:0') finish(null, `${port}\n`);
      else finish();
    });
    return child;
  }
  const service = createAndroidPhoneText({ config: () => current, execFile,
    fileStat: async () => ({ isFile: () => true }), timeoutMs: 50, startupMs: 140, commandMs: 100 });
  return { service, calls, messages, get serverStarts() { return serverStarts; }, get maxServers() { return maxServers; },
    change: c => { current = c; }, async close() {
      await service.dispose(); for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve));
    } };
}
async function withFixture(options, run) { const f = await fixture(options); try { await run(f); } finally { await f.close(); } }
function cleanupVerified(f) {
  const push = f.calls.find(c => c.args[2] === 'push');
  const forward = f.calls.find(c => c.args[2] === 'forward' && c.args[3] === 'tcp:0');
  if (push) assert(f.calls.some(c => c.args.slice(2).join(' ') === `shell rm -f ${push.args[4]}`));
  if (forward) assert(f.calls.some(c => c.args[2] === 'forward' && c.args[3] === '--remove'));
  assert(f.calls.every(c => !c.args.includes('--remove-all') && !c.args.includes('kill-server')));
}

test('UTF-8 text is verified before paste; fragmented ACKs; no text in argv', () => withFixture({ fragment: true }, async f => {
  const text = '设备所有者🙂\n中文 $() `echo` ; & " / path';
  assert.deepEqual(await f.service.setText(text), { acknowledged: true, clipboardVerified: true, pasteRequested: true, fieldVerified: false });
  assert.deepEqual(f.messages.map(m => [m.sequence, m.paste, m.text]), [[1n, 0, text], [2n, 1, text]]);
  assert(f.calls.every(c => c.args.every(a => !a.includes(text))));
  const start = f.calls.find(c => c.args.includes('com.genymobile.scrcpy.Server')).args;
  for (const arg of ['4.1', 'video=false', 'audio=false', 'clipboard_autosync=false', 'power_on=false', '20']) assert(start.includes(arg));
  assert(!start.some(a => /^(?:ime|input_method)$/.test(a))); cleanupVerified(f);
}));
test('invalid text rejected before any device command', () => withFixture({}, async f => {
  for (const text of ['', '\0', '\ud800', '字'.repeat(501), null]) await assert.rejects(f.service.setText(text), e => e.code === 'text');
  assert.equal(f.calls.length, 0);
}));
test('invalid fixed configuration rejected without fallback', () => withFixture({}, async f => {
  f.change({ ...cfg, serial: 'any;other' }); await assert.rejects(f.service.setText('中文'), e => e.code === 'config');
  assert.equal(f.calls.length, 0);
}));
test('offline device is not replaced by another device', () => withFixture({ offline: true }, async f => {
  await assert.rejects(f.service.setText('中文'), e => e.code === 'disconnected'); assert.equal(f.calls.length, 1);
}));
test('push failure is redacted and owned jar cleanup attempted', () => withFixture({ pushFails: true }, async f => {
  await assert.rejects(f.service.setText('中文'), e => e.code === 'startup' && !e.message.includes('secret'));
  assert.equal(f.serverStarts, 0); cleanupVerified(f);
}));
test('clipboard mismatch prevents paste', () => withFixture({ mismatch: true }, async f => {
  await assert.rejects(f.service.setText('中文'), e => e.code === 'clipboard' && !e.pasteMayHaveOccurred);
  assert.equal(f.messages.length, 1); cleanupVerified(f);
}));
test('wrong ACK never triggers paste or automatic retry', () => withFixture({ wrongAck: true }, async f => {
  await assert.rejects(f.service.setText('中文'), e => e.code === 'protocol' && !e.pasteMayHaveOccurred);
  assert.equal(f.messages.length, 1); assert.equal(f.serverStarts, 1); cleanupVerified(f);
}));
test('missing ACK times out and releases forward/server', () => withFixture({ noAck: true }, async f => {
  await assert.rejects(f.service.setText('中文'), e => e.code === 'timeout' && !e.pasteMayHaveOccurred);
  assert.equal(f.messages.length, 1); cleanupVerified(f);
}));
test('lost paste ACK is explicitly uncertain and never retried', () => withFixture({ noPasteAck: true }, async f => {
  await assert.rejects(f.service.setText('中文'), e => e.code === 'timeout' && e.pasteMayHaveOccurred);
  assert.equal(f.messages.filter(m => m.paste).length, 1); assert.equal(f.serverStarts, 1); cleanupVerified(f);
}));
test('disconnect after paste is explicitly uncertain', () => withFixture({ disconnectOnPaste: true }, async f => {
  await assert.rejects(f.service.setText('中文'), e => e.pasteMayHaveOccurred);
  assert.equal(f.messages.filter(m => m.paste).length, 1); cleanupVerified(f);
}));
test('oversized device clipboard response is bounded', () => withFixture({ oversize: true }, async f => {
  await assert.rejects(f.service.setText('中文'), e => e.code === 'protocol' && !e.pasteMayHaveOccurred);
  assert.equal(f.messages.length, 1); cleanupVerified(f);
}));
test('configuration change before paste aborts using original cleanup target', () => withFixture({ changeConfigOnSet: true }, async f => {
  await assert.rejects(f.service.setText('中文'), e => e.code === 'config' && !e.pasteMayHaveOccurred);
  assert.equal(f.messages.length, 1); cleanupVerified(f);
}));
test('concurrent requests serialize complete independent lifecycles', () => withFixture({}, async f => {
  await Promise.all([f.service.setText('第一条'), f.service.setText('第二条')]);
  assert.equal(f.maxServers, 1); assert.equal(f.serverStarts, 2);
  assert.deepEqual(f.messages.filter(m => m.paste).map(m => m.text), ['第一条', '第二条']); cleanupVerified(f);
}));
test('dispose stops current input and prevents queued/new input', () => withFixture({ noAck: true }, async f => {
  const one = f.service.setText('第一条').catch(e => e), two = f.service.setText('第二条').catch(e => e);
  while (!f.messages.length) await new Promise(resolve => setTimeout(resolve, 1));
  await f.service.dispose(); const first = await one, second = await two;
  assert(first instanceof Error); assert.equal(second.code, 'disposed');
  await assert.rejects(f.service.setText('第三条'), e => e.code === 'disposed');
  assert.equal(f.serverStarts, 1); cleanupVerified(f);
}));

for (let i = 0; i < cases.length; i++) {
  await cases[i].run(); console.log(`ok ${i + 1} - ${cases[i].name}`);
}
console.log(`${cases.length}/${cases.length} Android text protocol tests passed; no ADB or phone input used.`);
