import assert from 'node:assert/strict';
import test from 'node:test';
import { createAndroidPhoneService, AndroidPhoneError } from '../src/android-phone-service.js';

const OWNER = '11111';
const KEY = `private:${OWNER}`;
const SERIAL = 'OFFLINE_TEST_PHONE';
const UI_PATH = '/sdcard/qq-fish-window.xml';
const unquote = value => value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replaceAll("'\\''", "'") : value;
function png(width = 1080, height = 2400) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
const node = (text = '中文 &amp; A', bounds = '[0,10][1080,200]') =>
  `<node text="${text}" content-desc="描述" resource-id="com.example:id/field" class="android.widget.EditText" clickable="true" enabled="true" focused="true" bounds="${bounds}"/>`;
function fixture(options = {}) {
  const settings = { enabled: true, ownerQQ: OWNER, adbPath: 'C:\\offline\\adb.exe', serial: SERIAL };
  const calls = [], controls = { clock: 1_800_000_000_000, connected: true, image: png(),
    xml: `<hierarchy>${node()}</hierarchy>`, dump: `UI hierchary dumped to: ${UI_PATH}`, ...options.controls };
  let inFlight = 0, maxInFlight = 0;
  const run = async (file, args, opts) => {
    const entry = { file, args, opts, command: args[2] === 'shell' ? args.slice(3).map(unquote) : args.slice(2) };
    calls.push(entry); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (options.beforeRun) await options.beforeRun(entry, settings, controls);
      if (options.run) {
        const override = await options.run(entry, settings, controls);
        if (override !== undefined) return { stdout: override };
      }
      const [first, second] = entry.command;
      if (first === 'get-state') {
        if (!controls.connected) throw new Error('device unavailable secret-argument');
        return { stdout: Buffer.from('device\n') };
      }
      if (first === 'getprop') return { stdout: second === 'ro.product.model' ? 'nova 8 SE\n' : '10\n' };
      if (first === 'wm') return { stdout: 'Physical size: 1080x2400\nOverride size: 720x1600\n' };
      if (first === 'uiautomator') return { stdout: controls.dump };
      if (first === 'cat') return { stdout: controls.xml };
      if (first === 'exec-out') return { stdout: controls.image };
      if (first === 'cmd' && entry.command[2] === 'query-activities') return { stdout:
        '3 activities found:\ncom.example/.MainActivity\ncom.example/.Other\ncom.music/app.Main\nnot-a-component\n' };
      if (first === 'cmd' && entry.command[2] === 'resolve-activity') return { stdout: `${entry.command.at(-1)}/.MainActivity\n` };
      if (first === 'am') return { stdout: 'Starting: Intent { ... }\n' };
      if (first === 'input') return { stdout: '' };
      throw new Error('unexpected test command');
    } finally { inFlight--; }
  };
  const api = createAndroidPhoneService({ config: () => settings, run, now: () => controls.clock,
    setText: options.setText, sendScreenshot: options.sendScreenshot, recognizeText: options.recognizeText });
  return { api, settings, calls, controls, maxInFlight: () => maxInFlight,
    observe: () => api.observe({ key: KEY }) };
}
const rejects = (promise, code) => assert.rejects(promise, e => e instanceof AndroidPhoneError && e.code === code && !/secret|offline|OFFLINE_TEST/.test(e.message));
const inputCalls = f => f.calls.filter(c => c.command[0] === 'input' || c.command[0] === 'am');

test('OCR fills empty WeChat hierarchy and tap_text uses measured text bounds instead of model coordinates', async () => {
  const f=fixture({controls:{xml:'<hierarchy></hierarchy>'},recognizeText:async()=>[
    {text:'发送',bounds:{left:488,top:2062,right:590,bottom:2120}}]});
  const view=await f.observe();assert.equal(view.ocrNodes[0].text,'发送');
  const result=await f.api.act({key:KEY,observationId:view.observationId,action:'tap_text',targetText:'发送'});
  assert.deepEqual(inputCalls(f).at(-1).command,['input','tap','539','2091']);
  assert.equal(result.actionIssued,true);assert.equal(result.effectConfirmed,false);
});
test('missing or ambiguous OCR labels never produce a guessed tap', async()=>{
  const f=fixture({controls:{xml:'<hierarchy></hierarchy>'},recognizeText:async()=>[
    {text:'发送',bounds:{left:10,top:10,right:40,bottom:40}},
    {text:'发送',bounds:{left:100,top:100,right:140,bottom:140}}]});
  const view=await f.observe();
  await assert.rejects(f.api.act({key:KEY,observationId:view.observationId,action:'tap_text',targetText:'发送'}),/唯一/);
  await assert.rejects(f.api.act({key:KEY,observationId:view.observationId,action:'tap_text',targetText:'不存在'}),/唯一/);
  assert.equal(inputCalls(f).length,0);
});

test('reported UIA/OCR offset uses one screenshot target and dispatches its OCR center', async () => {
  const f = fixture({ controls: { xml: `<hierarchy>${node('确定', '[864,2147][1044,2197]')}</hierarchy>` },
    recognizeText: async () => [{ text: '确定', confidence: 1, bounds: { left: 906, top: 2191, right: 1000, bottom: 2246 } }] });
  const view = await f.observe();
  assert.equal(view.targets.length, 1);
  assert.deepEqual(view.targets[0].center, { x: 953, y: 2219 });
  assert.deepEqual(view.targetCoordinates, { space: 'original_screenshot_pixels', width: 1080, height: 2400 });
  await f.api.act({ key: KEY, observationId: view.observationId, action: 'tap_text', targetText: '确定' });
  assert.deepEqual(inputCalls(f).at(-1).command, ['input', 'tap', '953', '2219']);
});

test('OCR remains available when a partial UI hierarchy already contains several text nodes', async () => {
  let recognized = 0;
  const f = fixture({ controls: { xml: `<hierarchy>${node('标题')}${node('取消', '[0,200][100,240]')}${node('其他', '[0,300][100,340]')}</hierarchy>` },
    recognizeText: async () => { recognized++; return [{ text: '确定', bounds: { left: 906, top: 2191, right: 1000, bottom: 2246 } }]; } });
  const view = await f.observe();
  assert.equal(recognized, 1);
  assert.ok(view.targets.some(target => target.text === '确定' && target.source === 'ocr'));
});

test('same-name targets require a matching current ID and disabled targets never inject', async () => {
  const f = fixture({ controls: { xml: `<hierarchy>${node('确定', '[20,100][200,150]')}${node('确定', '[20,600][200,650]')}</hierarchy>` },
    recognizeText: async () => [{ text: '确定', bounds: { left: 70, top: 110, right: 150, bottom: 140 } },
      { text: '确定', bounds: { left: 70, top: 610, right: 150, bottom: 640 } }] });
  const view = await f.observe();
  assert.equal(view.targets.length, 2);
  for (const args of [{ targetText: '确定' }, { targetId: 'stale', targetText: '确定' },
    { targetId: view.targets[1].id, targetText: '取消' }])
    await assert.rejects(f.api.act({ key: KEY, observationId: view.observationId, action: 'tap_text', ...args }));
  assert.equal(inputCalls(f).length, 0);
  await f.api.act({ key: KEY, observationId: view.observationId, action: 'tap_text', targetText: '确定', targetId: view.targets[1].id });
  assert.deepEqual(inputCalls(f).at(-1).command, ['input', 'tap', '110', '625']);
  const disabled = fixture({ controls: { xml: `<hierarchy>${node('确定', '[864,2147][1044,2197]').replace('enabled="true"', 'enabled="false"')}</hierarchy>` },
    recognizeText: async () => [{ text: '确定', bounds: { left: 906, top: 2191, right: 1000, bottom: 2246 } }] });
  const blocked = await disabled.observe();
  await assert.rejects(disabled.api.act({ key: KEY, observationId: blocked.observationId, action: 'tap_text', targetText: '确定', targetId: blocked.targets[0].id }), { code: 'target_disabled' });
  assert.equal(inputCalls(disabled).length, 0);
});

test('target IDs and target text never silently fall back to supplied raw coordinates', async () => {
  const f = fixture(); const view = await f.observe();
  for (const args of [{ action: 'tap', x: 1, y: 1, targetId: view.targets[0].id },
    { action: 'tap_text', targetText: view.targets[0].text, targetId: view.targets[0].id, x: 1, y: 1 }])
    await rejects(f.api.act({ key: KEY, observationId: view.observationId, ...args }), 'action');
  assert.equal(inputCalls(f).length, 0);
});

test('legacy coordinate taps require visual preview and never submit input', async () => {
  const f = fixture(); const view = await f.observe();
  for (const action of ['tap','tap_normalized']) await rejects(f.api.act({key:KEY,observationId:view.observationId,action,x:500,y:125}),'coordinate_confirmation');
  assert.equal(inputCalls(f).length,0);
  await rejects(f.api.act({key:KEY,observationId:view.observationId,action:'tap_normalized',x:500,y:1200}),'coordinates');
});

test('only enabled owner private may access any phone operation', async () => {
  const f = fixture();
  for (const method of ['status', 'apps', 'observe', 'shareScreenshot', 'openApp', 'act']) {
    await rejects(f.api[method]({ key: 'group:22222' }), 'owner');
    await rejects(f.api[method]({ key: 'private:33333' }), 'owner');
  }
  assert.equal(f.calls.length, 0);
  f.settings.enabled = false;
  await rejects(f.api.status({ key: KEY }), 'disabled');
  assert.equal(f.calls.length, 0);
});

test('status uses only configured serial and reports model, version and current dimensions', async () => {
  const f = fixture();
  const result = await f.api.status({ key: KEY, serial: 'OTHER_PHONE' });
  assert.deepEqual(result, { connected: true, serial: SERIAL, model: 'nova 8 SE', androidVersion: '10', width: 720, height: 1600 });
  for (const call of f.calls) {
    assert.equal(call.file, f.settings.adbPath);
    assert.deepEqual(call.args.slice(0, 2), ['-s', SERIAL]);
    assert.equal(call.opts.windowsHide, true);
    assert.equal(call.opts.shell, false);
    assert.ok(call.opts.timeout <= 20_000 && call.opts.maxBuffer <= 16 * 1024 * 1024);
  }
});

test('disconnection is explicit and never falls back to an arbitrary device', async () => {
  const f = fixture({ controls: { connected: false } });
  assert.deepEqual(await f.api.status({ key: KEY }), { connected: false, serial: SERIAL });
  await rejects(f.api.apps({ key: KEY }), 'disconnected');
  await rejects(f.observe(), 'disconnected');
  assert.ok(f.calls.every(c => c.args[0] === '-s' && c.args[1] === SERIAL && c.command[0] === 'get-state'));
});

test('apps returns unique launcher packages without exposing raw activity output', async () => {
  const f = fixture();
  assert.deepEqual(await f.api.apps({ key: KEY }), { apps: [{ packageName: 'com.example' }, { packageName: 'com.music' }], truncated: false });
});

test('observe returns original PNG dimensions and bounded decoded UI nodes', async () => {
  const f = fixture({ controls: { image: png(2400, 1080), xml: `<hierarchy>${Array.from({ length: 105 }, () => node()).join('')}</hierarchy>` } });
  const o = await f.observe();
  assert.match(o.observationId, /^[0-9a-f-]{36}$/);
  assert.equal(o.expiresAt, f.controls.clock + 120_000);
  assert.equal(o.width, 2400); assert.equal(o.height, 1080);
  assert.equal(o.image.mimeType, 'image/png'); assert.deepEqual(Buffer.from(o.image.data, 'base64'), f.controls.image);
  assert.equal(o.nodes.length, 100); assert.equal(o.nodesTruncated, true);
  assert.equal(o.nodes[0].text, '中文 & A');
  assert.deepEqual(o.nodes[0].bounds, { left: 0, top: 10, right: 1080, bottom: 200 });
  assert.equal(o.hierarchyUnavailable, false);
});

test('failed fresh UI dump cannot reuse stale hierarchy, while a screenshot remains available', async () => {
  const f = fixture({ controls: { dump: 'ERROR: could not get idle state.' } });
  const o = await f.observe();
  assert.equal(o.hierarchyUnavailable, true);
  assert.deepEqual(o.nodes, []);
  assert.equal(f.calls.some(c => c.command[0] === 'cat'), false);
  assert.equal(o.image.mimeType, 'image/png');
});

test('tap requires a current observation and consumes it exactly once', async () => {
  const f = fixture();
  await rejects(f.api.act({ key: KEY, action: 'tap_text', targetText: '中文 & A' }), 'observation');
  const o = await f.observe();
  const request = { key: KEY, observationId: o.observationId, action: 'tap_text', targetText: '中文 & A' };
  const result = await f.api.act(request);
  assert.equal(result.ok, true); assert.equal(result.observationRequired, true);
  assert.equal(result.actionIssued, true); assert.equal(result.effectConfirmed, false);
  await rejects(f.api.act(request), 'observation');
  assert.deepEqual(inputCalls(f).map(c => c.command), [['input', 'tap', '540', '105']]);
});

test('expired, superseded and device-changed observations cannot cause actions', async () => {
  const f = fixture();
  const old = await f.observe();
  const current = await f.observe();
  await rejects(f.api.act({ key: KEY, observationId: old.observationId, action: 'key', button: 'home' }), 'observation');
  f.controls.clock += 120_001;
  await rejects(f.api.act({ key: KEY, observationId: current.observationId, action: 'key', button: 'home' }), 'observation');
  const latest = await f.observe();
  f.settings.serial = 'NEW_CONFIGURED_PHONE';
  await rejects(f.api.act({ key: KEY, observationId: latest.observationId, action: 'key', button: 'home' }), 'observation');
  assert.equal(inputCalls(f).length, 0);
});

test('coordinates, swipes and key events are strictly bounded enums', async () => {
  const f = fixture();
  const o = await f.observe();
  for (const [x, y] of [[-1, 0], [1080, 0], [0, 2400], [1.5, 1], ['1', 1]]) {
    await rejects(f.api.act({ key: KEY, observationId: o.observationId, action: 'tap', x, y }), 'coordinates');
  }
  await rejects(f.api.act({ key: KEY, observationId: o.observationId, action: 'key', button: 'power;id' }), 'action');
  await rejects(f.api.act({ key: KEY, observationId: o.observationId, action: 'shell', text: 'id' }), 'action');
  await rejects(f.api.act({ key: KEY, observationId: o.observationId, action: 'swipe', x1: 0, y1: 0, x2: 10, y2: 20, durationMs: 5001 }), 'action');
  await f.api.act({ key: KEY, observationId: o.observationId, action: 'swipe', x1: 0, y1: 0, x2: 1079, y2: 2399, durationMs: 500 });
  assert.deepEqual(inputCalls(f)[0].command, ['input', 'swipe', '0', '0', '1079', '2399', '500']);
  const next = await f.observe();
  await f.api.act({ key: KEY, observationId: next.observationId, action: 'key', button: 'back' });
  assert.deepEqual(inputCalls(f)[1].command, ['input', 'keyevent', '4']);
});

test('openApp requires an observation and only resolves a launcher component for a valid package', async () => {
  const f = fixture();
  await rejects(f.api.openApp({ key: KEY, packageName: 'com.example' }), 'observation');
  const o = await f.observe();
  await rejects(f.api.openApp({ key: KEY, observationId: o.observationId, packageName: 'com.example; id' }), 'package');
  await f.api.openApp({ key: KEY, observationId: o.observationId, packageName: 'com.example' });
  assert.equal(inputCalls(f).length, 1);
  assert.deepEqual(inputCalls(f)[0].command.slice(-2), ['-n', 'com.example/.MainActivity']);
  await rejects(f.api.openApp({ key: KEY, observationId: o.observationId, packageName: 'com.example' }), 'observation');
});

test('non-launchable packages and Android am error text cannot report success', async () => {
  const noLauncher = fixture({ run: async entry => entry.command[2] === 'resolve-activity' ? 'No activity found\n' : undefined });
  const o = await noLauncher.observe();
  await rejects(noLauncher.api.openApp({ key: KEY, observationId: o.observationId, packageName: 'com.example' }), 'package');
  assert.equal(inputCalls(noLauncher).length, 0);
  const failedStart = fixture({ run: async entry => entry.command[0] === 'am' ? 'Error: Activity not started\n' : undefined });
  const p = await failedStart.observe();
  await rejects(failedStart.api.openApp({ key: KEY, observationId: p.observationId, packageName: 'com.example' }), 'package');
  await rejects(failedStart.api.act({ key: KEY, observationId: p.observationId, action: 'key', button: 'home' }), 'observation');
});

test('ASCII fallback safely quotes the remote shell, not merely host argv', async () => {
  const f = fixture();
  const o = await f.observe();
  const text = "hello '; echo $(id) & `cmd` \\ world";
  await f.api.act({ key: KEY, observationId: o.observationId, action: 'text', text });
  const call = inputCalls(f)[0];
  assert.deepEqual(call.command, ['input', 'text', text.replaceAll(' ', '%s')]);
  assert.equal(call.args.length, 6);
  assert.ok(call.args[5].startsWith("'") && call.args[5].endsWith("'"));
  assert.ok(call.args[5].includes("'\\''"));
});

test('Chinese and ASCII both use one injected clipboard path when available', async () => {
  const texts = [];
  const f = fixture({ setText: async value => { texts.push(value); return { ok: true }; } });
  for (const text of ['你好，设备所有者！', "ascii ' $() %s", 'line1\nline2']) {
    const o = await f.observe();
    await f.api.act({ key: KEY, observationId: o.observationId, action: 'text', text });
    assert.deepEqual(texts.at(-1), { text, serial: SERIAL });
  }
  assert.equal(inputCalls(f).length, 0);
});

test('text limits and missing Unicode input reject without typing, callback failures consume observation', async () => {
  const f = fixture();
  const o = await f.observe();
  for (const text of ['', 'x'.repeat(501), 'a\0b']) await rejects(f.api.act({ key: KEY, observationId: o.observationId, action: 'text', text }), 'text');
  for (const text of ['中文', 'literal%s', 'line\nline']) await rejects(f.api.act({ key: KEY, observationId: o.observationId, action: 'text', text }), 'unicode');
  assert.equal(inputCalls(f).length, 0);
  const failed = fixture({ setText: async () => { throw new Error('secret payload and command'); } });
  const p = await failed.observe();
  await rejects(failed.api.act({ key: KEY, observationId: p.observationId, action: 'text', text: '中文' }), 'adb');
  await rejects(failed.api.act({ key: KEY, observationId: p.observationId, action: 'text', text: '中文' }), 'observation');
});

test('operations serialize and concurrent reuse of an observation cannot send two inputs', async () => {
  const f = fixture({ beforeRun: async () => { await new Promise(resolve => setTimeout(resolve, 1)); } });
  await Promise.all([f.api.status({ key: KEY }), f.api.apps({ key: KEY })]);
  const o = await f.observe();
  const results = await Promise.allSettled([1, 2].map(() => f.api.act({ key: KEY, observationId: o.observationId, action: 'tap_text', targetText: '中文 & A' })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'observation');
  assert.equal(f.maxInFlight(), 1);
  assert.equal(inputCalls(f).length, 1);
});

test('ADB failures consume attempted observations and do not leak command or text details', async () => {
  const f = fixture({ run: async entry => { if (entry.command[0] === 'input') throw new Error('secret arguments and input'); } });
  const o = await f.observe();
  await rejects(f.api.act({ key: KEY, observationId: o.observationId, action: 'tap_text', targetText: '中文 & A' }), 'adb');
  await rejects(f.api.act({ key: KEY, observationId: o.observationId, action: 'tap_text', targetText: '中文 & A' }), 'observation');
});

test('configuration revocation during a read prevents its result from being returned', async () => {
  const f = fixture({ beforeRun: async (entry, settings) => { if (entry.command[0] === 'exec-out') settings.enabled = false; } });
  await rejects(f.observe(), 'disabled');
});

test('invalid screenshots and out-of-range node coordinates are not accepted as usable observations', async () => {
  const bad = fixture({ controls: { image: Buffer.from('not a png') } });
  await rejects(bad.observe(), 'image');
  const f = fixture({ controls: { xml: `<hierarchy>${node('offscreen', '[2000,0][2500,10]')}${node('zero', '[1,1][1,1]')}${node('valid', '[1,1][20,20]')}</hierarchy>` } });
  const o = await f.observe();
  assert.deepEqual(o.nodes.map(n => n.text), ['valid']);
});

test('screenshot sharing sends exactly the observed original PNG and no caller-selected source or target', async () => {
  const delivered = [];
  const f = fixture({ sendScreenshot: async request => { delivered.push(request); return { messageId: -123 }; } });
  const o = await f.observe();
  const original = Buffer.from(o.image.data, 'base64');
  f.controls.image.fill(0); // The service retains its own immutable observation bytes.
  const result = await f.api.shareScreenshot({ key: KEY, observationId: o.observationId,
    userId: 'OTHER', targetKey: 'group:OTHER', url: 'https://ignored.invalid', path: 'ignored-file', png: Buffer.from('ignored') });
  assert.equal(result.sent, true); assert.equal(result.status, 'sent'); assert.equal(result.messageId, '-123');
  assert.equal(result.width, 1080); assert.equal(result.height, 2400);
  assert.equal(result.capturedAt, f.controls.clock); assert.equal(result.duplicate, false);
  assert.equal(delivered.length, 1); assert.deepEqual(delivered[0].png, original);
  assert.deepEqual(Object.keys(delivered[0]).sort(), ['height', 'key', 'observationId', 'png', 'width']);
  assert.equal(delivered[0].key, KEY); assert.equal(delivered[0].observationId, o.observationId);
  assert.equal(result.image, undefined); assert.equal(result.png, undefined); assert.equal(o.png, undefined);
  assert.equal(inputCalls(f).length, 0);
});

test('successful screenshot retries return the original receipt without a second send', async () => {
  let sends = 0;
  const f = fixture({ sendScreenshot: async () => { sends++; return '987'; } });
  const o = await f.observe(); const request = { key: KEY, observationId: o.observationId };
  const [first, second] = await Promise.all([f.api.shareScreenshot(request), f.api.shareScreenshot(request)]);
  assert.equal(first.sent, true); assert.equal(first.duplicate, false);
  assert.equal(second.sent, true); assert.equal(second.duplicate, true); assert.equal(second.messageId, '987');
  assert.equal(sends, 1);
});

test('screenshot delivery never consumes the observation used for subsequent phone control', async () => {
  const f = fixture({ sendScreenshot: async () => ({ messageId: '456' }) });
  const o = await f.observe();
  await f.api.shareScreenshot({ key: KEY, observationId: o.observationId });
  await f.api.act({ key: KEY, observationId: o.observationId, action: 'tap_text', targetText: '中文 & A' });
  assert.equal(inputCalls(f).length, 1);
  await rejects(f.api.shareScreenshot({ key: KEY, observationId: o.observationId }), 'observation');
});

test('screenshot sharing rejects unknown, expired, replaced or device-changed observation before delivery', async () => {
  let sends = 0;
  const f = fixture({ sendScreenshot: async () => { sends++; return '123'; } });
  await rejects(f.api.shareScreenshot({ key: KEY, observationId: 'unknown' }), 'observation');
  const old = await f.observe(); const latest = await f.observe();
  await rejects(f.api.shareScreenshot({ key: KEY, observationId: old.observationId }), 'observation');
  f.controls.clock += 120_001;
  await rejects(f.api.shareScreenshot({ key: KEY, observationId: latest.observationId }), 'observation');
  const current = await f.observe(); f.settings.serial = 'CHANGED_PHONE';
  await rejects(f.api.shareScreenshot({ key: KEY, observationId: current.observationId }), 'observation');
  assert.equal(sends, 0);
});

test('screenshot delivery requires owner and live scope even if an observation ID is known', async () => {
  let sends = 0;
  const f = fixture({ sendScreenshot: async () => { sends++; return '123'; } });
  const o = await f.observe();
  for (const key of ['group:22222', 'private:33333']) await rejects(f.api.shareScreenshot({ key, observationId: o.observationId }), 'owner');
  f.settings.enabled = false;
  await rejects(f.api.shareScreenshot({ key: KEY, observationId: o.observationId }), 'disabled');
  assert.equal(sends, 0);
});

test('missing screenshot callback gives an explicit unavailable capability error', async () => {
  const f = fixture(); const o = await f.observe();
  await rejects(f.api.shareScreenshot({ key: KEY, observationId: o.observationId }), 'screenshot_disabled');
  await f.api.act({ key: KEY, observationId: o.observationId, action: 'key', button: 'home' });
  assert.equal(inputCalls(f).length, 1);
});

test('uncertain screenshot delivery closes that observation to retries without exposing the failure payload', async () => {
  let sends = 0;
  const f = fixture({ sendScreenshot: async () => { sends++; throw new Error('secret callback parameters'); } });
  const o = await f.observe(); const request = { key: KEY, observationId: o.observationId };
  const first = await f.api.shareScreenshot(request), retry = await f.api.shareScreenshot(request);
  assert.equal(first.sent, false); assert.equal(first.status, 'uncertain');
  assert.deepEqual(first, retry); assert.equal(sends, 1);
  assert.ok(!JSON.stringify(first).includes('secret')); assert.match(first.error, /不能重复/);
  await f.api.act({ ...request, action: 'key', button: 'back' });
  assert.equal(inputCalls(f).length, 1);
});

test('only a definite no-send failure allows screenshot retry, using unchanged original bytes', async () => {
  let sends = 0; const bytes = [];
  const f = fixture({ sendScreenshot: async request => {
    sends++; bytes.push(Buffer.from(request.png));
    if (sends === 1) { request.png.fill(0); throw Object.assign(new Error('secret known rejection'), { definite: true }); }
    return { messageId: '321' };
  } });
  const o = await f.observe(); const request = { key: KEY, observationId: o.observationId };
  await rejects(f.api.shareScreenshot(request), 'screenshot_send');
  const success = await f.api.shareScreenshot(request);
  assert.equal(success.sent, true); assert.equal(success.messageId, '321'); assert.equal(sends, 2);
  assert.deepEqual(bytes[0], bytes[1]); assert.deepEqual(bytes[1], Buffer.from(o.image.data, 'base64'));
});

test('malformed or explicitly unsuccessful screenshot receipts remain uncertain and are not retried', async () => {
  for (const receipt of [undefined, null, {}, { messageId: 0 }, { messageId: 'not-an-id' },
    { messageId: '123', ok: false }, { messageId: '123', sent: false }]) {
    let sends = 0;
    const f = fixture({ sendScreenshot: async () => { sends++; return receipt; } });
    const o = await f.observe(); const request = { key: KEY, observationId: o.observationId };
    const result = await f.api.shareScreenshot(request);
    assert.equal(result.sent, false); assert.equal(result.status, 'uncertain');
    await f.api.shareScreenshot(request); assert.equal(sends, 1);
  }
});

const secureWindowDump = '  Window #1 Window{abc u0 com.example/.Protected}:\n    mAttrs={(0,0)(fillxfill)\n      fl=LAYOUT_IN_SCREEN SECURE HARDWARE_ACCELERATED}\n    mViewVisibility=0x0\n    mHasSurface=true\n    isOnScreen=true\n    isVisible=true\n';

test('visible protected screen is explained before capture and invalidates any earlier observation', async () => {
  let secure = false;
  const f = fixture({run:async entry => entry.command[0] === 'dumpsys' ? Buffer.from(secure ? secureWindowDump : '') : undefined});
  const view = await f.observe(); secure = true;
  const before = f.calls.filter(c=>c.command[0]==='exec-out').length;
  await assert.rejects(f.observe(), e=>e.code==='screen_protected' && /停止重试/.test(e.message));
  assert.equal(f.calls.filter(c=>c.command[0]==='exec-out').length,before);
  await rejects(f.api.act({key:KEY,observationId:view.observationId,action:'tap',x:10,y:10}),'observation');
  assert.equal(inputCalls(f).length,0);
  secure = false; assert.ok((await f.observe()).observationId);
});

test('protection appearing during capture produces protected reason instead of invalid PNG retry', async () => {
  let checks = 0;
  const f=fixture({controls:{image:Buffer.alloc(0)},run:async entry => entry.command[0]==='dumpsys' ? Buffer.from(++checks===1?'':secureWindowDump) : undefined});
  await rejects(f.observe(),'screen_protected'); assert.equal(checks,2);
  assert.equal(f.calls.filter(c=>c.command[0]==='exec-out').length,1);
});

test('unavailable window diagnostics does not claim protection or prevent normal captures', async () => {
  const f=fixture();assert.ok((await f.observe()).image);
  f.controls.image=Buffer.alloc(0);await rejects(f.observe(),'image');
});
