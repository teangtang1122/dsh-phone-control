import { execFile as nativeExecFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

// Wire format is pinned to Genymobile/scrcpy v4.1, ControlMessageReader and
// DeviceMessageWriter. No user text is ever passed to an Android shell.
const VERSION = '4.1';
const MAX_BYTES = 256 * 1024 - 14;
const TEXT_ERRORS = {
  config: '手机中文输入配置无效或已变化，请重新查看手机。',
  text: '输入内容必须是 1 到 500 个字符，且不能包含空字符或损坏的 Unicode。',
  disconnected: '指定的备用手机未连接，未向其他设备发送输入。',
  startup: '手机中文输入组件启动失败，请检查指定设备和 scrcpy 4.1。',
  timeout: '手机中文输入等待超时，请先重新查看手机；不要盲目重复输入。',
  protocol: '手机中文输入组件返回了无法核实的响应，请重新查看手机。',
  clipboard: '手机剪贴板写入未能核实，未执行粘贴。',
  disposed: '手机中文输入组件已关闭。',
  busy: '手机中文输入队列已满，请稍后重新查看手机。'
};
export class AndroidPhoneTextError extends Error {
  constructor(code, pasteMayHaveOccurred = false) {
    super(TEXT_ERRORS[code] || TEXT_ERRORS.startup);
    this.name = 'AndroidPhoneTextError';
    this.code = code;
    this.pasteMayHaveOccurred = pasteMayHaveOccurred;
  }
}
function failure(code) { return new AndroidPhoneTextError(code); }
function clipboardMessage(text, sequence, paste) {
  const bytes = Buffer.from(text, 'utf8');
  const buffer = Buffer.allocUnsafe(14 + bytes.length);
  buffer[0] = 9;
  buffer.writeBigUInt64BE(sequence, 1);
  buffer[9] = paste ? 1 : 0;
  buffer.writeUInt32BE(bytes.length, 10);
  bytes.copy(buffer, 14);
  return buffer;
}
function reader(socket, timeoutMs) {
  let buffer = Buffer.alloc(0), error = null, waiter = null;
  function pump() {
    if (!waiter) return;
    if (error) { const w = waiter; waiter = null; clearTimeout(w.timer); w.reject(error); }
    else if (buffer.length >= waiter.size) {
      const w = waiter; waiter = null; clearTimeout(w.timer);
      const bytes = buffer.subarray(0, w.size); buffer = buffer.subarray(w.size); w.resolve(bytes);
    }
  }
  socket.on('data', chunk => {
    if (buffer.length + chunk.length > MAX_BYTES + 32) error = failure('protocol');
    else buffer = Buffer.concat([buffer, chunk]);
    pump();
  });
  socket.on('error', () => { error = failure('startup'); pump(); });
  socket.on('close', () => { error = failure('startup'); pump(); });
  return {
    read(size) {
      if (waiter) return Promise.reject(failure('protocol'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiter = null; reject(failure('timeout')); }, timeoutMs);
        waiter = { size, resolve, reject, timer }; pump();
      });
    },
    async ack(sequence) {
      if ((await this.read(1))[0] !== 1 || (await this.read(8)).readBigUInt64BE() !== sequence) throw failure('protocol');
    },
    async clipboard() {
      if ((await this.read(1))[0] !== 0) throw failure('protocol');
      const size = (await this.read(4)).readUInt32BE();
      if (size > MAX_BYTES) throw failure('protocol');
      return this.read(size);
    }
  };
}

/** Creates a short-lived, fixed-device clipboard connection on demand.
 * Success confirms the clipboard and scrcpy paste ACK, not the focused field.
 * The caller must inspect the phone after input; failures are never auto-retried.
 * execFile/connect/fileStat are injectable solely for offline protocol tests.
 */
export function createAndroidPhoneText({ config, execFile = nativeExecFile,
  connect = options => net.createConnection(options), fileStat = stat,
  timeoutMs = 5_000, startupMs = 8_000, commandMs = 8_000 } = {}) {
  let queue = Promise.resolve(), queued = 0, disposed = false, active = null;
  function current() {
    let c;
    try { c = config?.(); } catch { throw failure('config'); }
    if (c?.enabled === false) throw failure('config');
    const cfg = { adbPath: c?.adbPath, serial: c?.serial, scrcpyServerPath: c?.scrcpyServerPath };
    if (Object.values(cfg).some(v => typeof v !== 'string' || !v || v.includes('\0'))
      || !/^[A-Za-z0-9_.-]{1,128}$/.test(cfg.serial)
      || !path.isAbsolute(cfg.adbPath) || !path.isAbsolute(cfg.scrcpyServerPath)) throw failure('config');
    return cfg;
  }
  function ensure(cfg) {
    if (disposed) throw failure('disposed');
    const latest = current();
    if (Object.keys(cfg).some(k => cfg[k] !== latest[k])) throw failure('config');
  }
  function adb(cfg, args, timeout = commandMs) {
    return new Promise((resolve, reject) => {
      execFile(cfg.adbPath, ['-s', cfg.serial, ...args],
        { windowsHide: true, shell: false, timeout, maxBuffer: 64 * 1024, encoding: 'utf8' },
        (error, stdout) => error ? reject(failure(error.killed ? 'timeout' : 'startup')) : resolve(String(stdout || '')));
    });
  }
  async function perform(text) {
    const cfg = current(); ensure(cfg);
    const files = await Promise.all([fileStat(cfg.adbPath), fileStat(cfg.scrcpyServerPath)]).catch(() => { throw failure('config'); });
    if (files.some(f => !f.isFile())) throw failure('config');
    if ((await adb(cfg, ['get-state'])).trim() !== 'device') throw failure('disconnected');
    ensure(cfg);
    const id = (randomBytes(4).readUInt32BE() & 0x7fffffff).toString(16).padStart(8, '0');
    const remoteJar = `/data/local/tmp/qq-fish-text-${id}.jar`;
    const remoteSocket = `localabstract:scrcpy_${id}`;
    let port = null, jarAttempted = false, forwardAttempted = false, pasteRequested = false;
    let server = null, serverExited = false, serverDone = Promise.resolve();
    let socket = null;
    active = { stop() { socket?.destroy(); server?.kill(); } };
    try {
      jarAttempted = true;
      await adb(cfg, ['push', cfg.scrcpyServerPath, remoteJar]); ensure(cfg);
      forwardAttempted = true;
      const allocated = (await adb(cfg, ['forward', 'tcp:0', remoteSocket])).trim();
      if (!/^\d+$/.test(allocated) || Number(allocated) < 1 || Number(allocated) > 65535) throw failure('startup');
      port = Number(allocated); ensure(cfg);
      // Android 10's toybox timeout prevents an orphan if the host dies before
      // the control socket opens. All shell arguments are fixed/generated here.
      serverDone = new Promise(resolve => {
        server = execFile(cfg.adbPath, ['-s', cfg.serial, 'shell', `CLASSPATH=${remoteJar}`,
          'toybox', 'timeout', '-s', 'KILL', '20', 'app_process', '/', 'com.genymobile.scrcpy.Server', VERSION,
          `scid=${id}`, 'video=false', 'audio=false', 'control=true', 'tunnel_forward=true',
          'send_device_meta=false', 'send_dummy_byte=true', 'clipboard_autosync=false',
          'power_on=false', 'cleanup=true', 'log_level=error'],
        { windowsHide: true, shell: false, timeout: 22_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
        () => { serverExited = true; resolve(); });
      });
      const deadline = Date.now() + startupMs;
      let input = null;
      while (Date.now() < deadline) {
        ensure(cfg);
        if (serverExited) throw failure('startup');
        socket = connect({ host: '127.0.0.1', port });
        socket.setNoDelay?.(true);
        input = reader(socket, Math.min(timeoutMs, Math.max(1, deadline - Date.now())));
        try {
          if ((await input.read(1))[0] !== 0) throw failure('protocol');
          break;
        } catch (error) {
          socket.destroy(); socket = null; input = null;
          if (error.code === 'protocol') throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      if (!input || !socket) throw failure('timeout');
      ensure(cfg);
      // Verify the new clipboard before asking Android to paste. scrcpy sends
      // an ACK even if its platform clipboard setter returns false.
      socket.write(clipboardMessage(text, 1n, false));
      await input.ack(1n); ensure(cfg);
      socket.write(Buffer.from([8, 0])); // GET_CLIPBOARD, COPY_KEY_NONE
      if (!(await input.clipboard()).equals(Buffer.from(text, 'utf8'))) throw failure('clipboard');
      ensure(cfg);
      pasteRequested = true;
      socket.write(clipboardMessage(text, 2n, true));
      await input.ack(2n);
      return { acknowledged: true, clipboardVerified: true, pasteRequested: true, fieldVerified: false };
    } catch (error) {
      const safe = error instanceof AndroidPhoneTextError ? error : failure('startup');
      safe.pasteMayHaveOccurred = pasteRequested;
      throw safe;
    } finally {
      socket?.destroy();
      // Closing the control channel terminates scrcpy. Give it a short graceful
      // interval, then release the local adb process; remote timeout is a backstop.
      let timer;
      await Promise.race([serverDone, new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
      clearTimeout(timer);
      if (server && !serverExited) server.kill();
      if (port) await adb(cfg, ['forward', '--remove', `tcp:${port}`], 2_000).catch(() => {});
      else if (forwardAttempted) {
        const list = await adb(cfg, ['forward', '--list'], 2_000).catch(() => '');
        for (const row of list.trim().split(/\r?\n/)) {
          const [serial, local, remote] = row.trim().split(/\s+/);
          if (serial === cfg.serial && remote === remoteSocket && /^tcp:\d+$/.test(local))
            await adb(cfg, ['forward', '--remove', local], 2_000).catch(() => {});
        }
      }
      if (jarAttempted) await adb(cfg, ['shell', 'rm', '-f', remoteJar], 2_000).catch(() => {});
      active = null;
    }
  }
  return {
    setText(text) {
      if (typeof text !== 'string' || !text.length || [...text].length > 500 || text.includes('\0')
        || !text.isWellFormed() || Buffer.byteLength(text) > MAX_BYTES) return Promise.reject(failure('text'));
      if (disposed) return Promise.reject(failure('disposed'));
      if (queued >= 4) return Promise.reject(failure('busy'));
      queued++;
      const result = queue.then(() => perform(text));
      queue = result.catch(() => {});
      return result.finally(() => { queued--; });
    },
    async dispose() { disposed = true; active?.stop(); await queue; }
  };
}
