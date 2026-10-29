// Offline only: every ADB command and delay is replaced. No device, account,
// network, or real process is accessed by these tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePhoneActionFeedback } from '../src/android-phone-feedback.js';
import { createAndroidPhoneService, AndroidPhoneError } from '../src/android-phone-service.js';

const KEY = 'private:11111';
const UI_PATH = '/sdcard/qq-fish-window.xml';
const SECURE_WINDOW = '  Window #1 Window{fixture u0 com.example/.Protected}:\n'
  + '    mAttrs={(0,0)(fillxfill)\n      fl=LAYOUT_IN_SCREEN SECURE HARDWARE_ACCELERATED}\n'
  + '    mViewVisibility=0x0\n    mHasSurface=true\n    isOnScreen=true\n    isVisible=true\n';
const unquote = value => value.startsWith("'") && value.endsWith("'")
  ? value.slice(1, -1).replaceAll("'\\''", "'") : value;

// The service validates the PNG header and dimensions. Payload markers let us
// tell the original observation apart from both post-action samples.
function png(marker = 0, bytes = 34) {
  const image = Buffer.alloc(bytes);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.writeUInt32BE(13, 8);
  image.write('IHDR', 12);
  image.writeUInt32BE(1080, 16);
  image.writeUInt32BE(2400, 20);
  image[33] = marker;
  return image;
}

function fixture(options = {}) {
  const calls = [], waits = [];
  const state = { clock: 1_800_000_000_000, secure: false, inputs: 0, screenshots: 0,
    config: { enabled: true, ownerQQ: '11111', adbPath: 'OFFLINE_ADB_NOT_AN_EXECUTABLE', serial: 'OFFLINE_PHONE' } };
  const run = async (file, args, opts) => {
    assert.equal(file, 'OFFLINE_ADB_NOT_AN_EXECUTABLE');
    assert.deepEqual(args.slice(0, 2), ['-s', 'OFFLINE_PHONE']);
    assert.equal(opts.shell, false);
    const command = args[2] === 'shell' ? args.slice(3).map(unquote) : args.slice(2);
    calls.push(command);
    if (options.command) await options.command(state, command);
    if (command[0] === 'get-state') return { stdout: Buffer.from('device\n') };
    if (command[0] === 'dumpsys') return { stdout: Buffer.from(state.secure ? SECURE_WINDOW : '') };
    if (command[0] === 'uiautomator') return { stdout: Buffer.from(`UI hierarchy dumped to: ${UI_PATH}`) };
    if (command[0] === 'cat') return { stdout: Buffer.from('<hierarchy><node text="确定" clickable="true" enabled="true" bounds="[901,2200][1001,2278]"/></hierarchy>') };
    if (command[0] === 'exec-out') {
      assert.deepEqual(command, ['exec-out', 'screencap', '-p']);
      state.screenshots++;
      if (state.inputs && options.capture) return { stdout: await options.capture(state) };
      return { stdout: png(state.screenshots) };
    }
    if (command[0] === 'input') {
      state.inputs++;
      if (options.input) await options.input(state, command);
      return { stdout: Buffer.alloc(0) };
    }
    throw new Error(`Unexpected offline command: ${command[0]}`);
  };
  const api = createAndroidPhoneService({
    config: () => state.config,
    run, now: () => state.clock,
    wait: async ms => { waits.push(ms); state.clock += ms; },
  });
  return { api, calls, waits, state, observe: () => api.observe({ key: KEY }) };
}

test('feedback samples two ordered frames with a 400ms injected interval and no observation lease', async () => {
  let clock = 1000, captures = 0;
  const waits = [];
  const feedback = await capturePhoneActionFeedback({ actionCompletedAt: clock, now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms; },
    capture: async () => ({ png: png(++captures), width: 1080, height: 2400 }),
  });
  assert.equal(feedback.status, 'captured');
  assert.deepEqual(waits, [400]);
  assert.equal(captures, 2);
  assert.deepEqual(feedback.frames.map(f => [f.index, f.capturedAt, f.afterActionMs]), [[1, 1000, 0], [2, 1400, 400]]);
  for (const frame of feedback.frames) {
    assert.equal(frame.width, 1080);
    assert.equal(frame.height, 2400);
    assert.equal(frame.image.mimeType, 'image/png');
    assert.equal(frame.observationId, undefined);
    assert.equal(Buffer.from(frame.image.data, 'base64')[33], frame.index);
  }
  assert.equal(feedback.observationId, undefined);
  assert.match(feedback.hint, /页面跳转不证明/);
});

test('feedback enforces both the per-frame and aggregate byte budgets', async () => {
  for (const [options,expectedStatus,expectedFrames] of [
    [{ maxFrameBytes: 33 }, 'unavailable', 0],
    [{ maxBytes: 60 }, 'partial', 1],
    [{ maxBytes: 68, maxFrameBytes: 34 }, 'captured', 2],
  ]) {
    const feedback = await capturePhoneActionFeedback({ actionCompletedAt: 0, now: () => 0,
      wait: async () => {}, capture: async () => ({ png: png(), width: 1080, height: 2400 }), ...options });
    assert.equal(feedback.status, expectedStatus);
    assert.equal(feedback.frames.length, expectedFrames);
    assert.equal(feedback.reason, expectedStatus === 'captured' ? undefined : 'size_limit');
  }
  const tooLarge = await capturePhoneActionFeedback({ actionCompletedAt: 0, now: () => 0,
    wait: async () => {}, capture: async () => ({ png: png(1, 4 * 1024 * 1024 + 1), width: 1080, height: 2400 }) });
  assert.equal(tooLarge.reason, 'size_limit');
  assert.deepEqual(tooLarge.frames, []);
});

test('a later capture failure retains only earlier valid evidence and never exposes raw failure text', async () => {
  let captures = 0;
  const feedback = await capturePhoneActionFeedback({ actionCompletedAt: 0, now: () => 0, wait: async () => {},
    capture: async () => {
      if (++captures === 2) throw new Error('private failure payload must not escape');
      return { png: png(1), width: 1080, height: 2400 };
    },
  });
  assert.equal(feedback.status, 'partial');
  assert.equal(feedback.reason, 'capture_failed');
  assert.equal(feedback.frames.length, 1);
  assert.ok(!JSON.stringify(feedback).includes('private failure payload'));
});

test('read-only observe never sends input or collects action feedback', async () => {
  const f = fixture();
  const view = await f.observe();
  assert.ok(view.observationId);
  assert.equal(view.feedback, undefined);
  assert.equal(f.state.inputs, 0);
  assert.equal(f.state.screenshots, 1);
  assert.deepEqual(f.waits, []);
});

test('actual act issues one tap then captures twice without UIAutomator and leaves the observation consumed', async () => {
  const f = fixture();
  const view = await f.observe();
  const start = f.calls.length;
  const request = { key: KEY, observationId: view.observationId, action: 'tap_text', targetText: '确定' };
  const result = await f.api.act(request);
  const commands = f.calls.slice(start);
  assert.deepEqual(commands.filter(c => c[0] === 'input'), [['input', 'tap', '951', '2239']]);
  assert.equal(commands.filter(c => c[0] === 'exec-out').length, 2);
  assert.ok(commands.findIndex(c => c[0] === 'input') < commands.findIndex(c => c[0] === 'exec-out'));
  assert.ok(!commands.some(c => ['uiautomator', 'cat'].includes(c[0])));
  assert.deepEqual(f.waits, [400]);
  assert.equal(result.actionIssued, true);
  assert.equal(result.effectConfirmed, false);
  assert.equal(result.observationRequired, true);
  assert.equal(result.execution.tool, 'phone_action');
  assert.equal(result.execution.transport, 'adb');
  assert.deepEqual(result.execution.point, { x: 951, y: 2239 });
  assert.equal(result.feedback.status, 'captured');
  assert.deepEqual(result.feedback.frames.map(frame => Buffer.from(frame.image.data, 'base64')[33]), [2, 3]);
  assert.equal(result.observationId, undefined);
  const callCount = f.calls.length;
  await assert.rejects(f.api.act(request), error => error instanceof AndroidPhoneError && error.code === 'observation');
  assert.equal(f.calls.length, callCount);
});

test('unpreviewed coordinate tap produces no input or action feedback', async () => {
  const f = fixture();const view = await f.observe();
  await assert.rejects(f.api.act({key:KEY,observationId:view.observationId,action:'tap_normalized',x:881,y:933}),error=>error.code==='coordinate_confirmation');
  assert.equal(f.state.inputs,0);assert.equal(f.state.screenshots,1);
});

test('capture failures after input do not turn issued input into failure or retry it', async t => {
  for (const [name,capture,reason] of [
    ['bad PNG', async () => Buffer.from('invalid'), 'capture_failed'],
    ['ADB failure', async () => { throw new Error('private ADB failure payload'); }, 'capture_failed'],
    ['oversized PNG', async () => png(9, 4 * 1024 * 1024 + 1), 'size_limit'],
  ]) await t.test(name, async () => {
    const f = fixture({ capture });
    const view = await f.observe();
    const request = { key: KEY, observationId: view.observationId, action: 'tap_text', targetText: '确定' };
    const result = await f.api.act(request);
    assert.equal(result.actionIssued, true);
    assert.equal(result.effectConfirmed, false);
    assert.equal(result.observationRequired, true);
    assert.equal(result.feedback.status, 'unavailable');
    assert.equal(result.feedback.reason, reason);
    assert.deepEqual(result.feedback.frames, []);
    assert.equal(f.state.inputs, 1);
    assert.ok(!JSON.stringify(result).includes('private ADB failure'));
    await assert.rejects(f.api.act(request), error => error.code === 'observation');
    assert.equal(f.state.inputs, 1);
  });
});

test('a screen protected immediately after the tap produces no feedback image or screenshot attempt', async () => {
  const f = fixture({ input: state => { state.secure = true; } });
  const view = await f.observe();
  const result = await f.api.act({ key: KEY, observationId: view.observationId, action: 'tap_text', targetText: '确定' });
  assert.equal(result.actionIssued, true);
  assert.equal(result.effectConfirmed, false);
  assert.equal(result.feedback.reason, 'screen_protected');
  assert.deepEqual(result.feedback.frames, []);
  assert.equal(f.state.inputs, 1);
  assert.equal(f.state.screenshots, 1); // Only the pre-action observation.
});

test('protection appearing during screencap discards that frame before returning it', async () => {
  const f = fixture({ capture: state => { state.secure = true; return png(99); } });
  const view = await f.observe();
  const result = await f.api.act({ key: KEY, observationId: view.observationId, action: 'tap_text', targetText: '确定' });
  assert.equal(result.actionIssued, true);
  assert.equal(result.effectConfirmed, false);
  assert.equal(result.feedback.reason, 'screen_protected');
  assert.deepEqual(result.feedback.frames, []);
  assert.equal(f.state.inputs, 1);
  assert.equal(f.state.screenshots, 2);
  assert.ok(!JSON.stringify(result).includes(png(99).toString('base64')));
});

test('configuration changes during post-input evidence retain only the issued-input fact', async t => {
  for (const [name, command, expectedScreenshots] of [
    ['revoked after input', (state, command) => {
      if (state.inputs && command[0] === 'dumpsys') state.config.enabled = false;
    }, 1],
    ['device changed after a screenshot', (state, command) => {
      if (state.inputs && command[0] === 'exec-out') state.config.serial = 'CHANGED_OFFLINE_PHONE';
    }, 2],
    ['revoked after an earlier frame was collected', (state, command) => {
      if (state.inputs && command[0] === 'exec-out' && state.screenshots === 2) state.config.enabled = false;
    }, 3],
  ]) await t.test(name, async () => {
    const f = fixture({ command });
    const view = await f.observe();
    const request = { key: KEY, observationId: view.observationId, action: 'tap_text', targetText: '确定' };
    const result = await f.api.act(request);
    assert.deepEqual(Object.keys(result).sort(), ['actionIssued', 'effectConfirmed', 'feedback', 'hint', 'observationRequired', 'ok']);
    assert.equal(result.ok, true);
    assert.equal(result.actionIssued, true);
    assert.equal(result.effectConfirmed, false);
    assert.equal(result.observationRequired, true);
    assert.deepEqual(result.feedback, { status: 'unavailable', reason: 'authorization_changed', frames: [] });
    assert.equal(f.state.inputs, 1);
    assert.equal(f.state.screenshots, expectedScreenshots);
    const serialized = JSON.stringify(result);
    for (const omitted of [view.observationId, '确定', 'CHANGED_OFFLINE_PHONE', png(2).toString('base64')]) {
      assert.ok(!serialized.includes(omitted));
    }
    // Re-enabling access never revives the consumed operation lease.
    f.state.config.enabled = true;
    f.state.config.serial = 'OFFLINE_PHONE';
    await assert.rejects(f.api.act(request), error => error.code === 'observation');
    assert.equal(f.state.inputs, 1);
  });
});

test('configuration revocation still rejects reads and actions that have issued no input', async t => {
  await t.test('read revoked during screenshot', async () => {
    const f = fixture({ command: (state, command) => {
      if (command[0] === 'exec-out') state.config.enabled = false;
    } });
    await assert.rejects(f.observe(), error => error instanceof AndroidPhoneError && error.code === 'disabled');
    assert.equal(f.state.inputs, 0);
  });
  await t.test('action revoked before input', async () => {
    const f = fixture();
    const view = await f.observe();
    f.state.config.enabled = false;
    await assert.rejects(f.api.act({ key: KEY, observationId: view.observationId, action: 'tap', x: 1, y: 1 }),
      error => error instanceof AndroidPhoneError && error.code === 'disabled');
    assert.equal(f.state.inputs, 0);
  });
});

test('an input failure never triggers evidence collection or a second input', async () => {
  const f = fixture({ input: () => { throw new Error('offline input failure'); } });
  const view = await f.observe();
  const request = { key: KEY, observationId: view.observationId, action: 'tap_text', targetText: '确定' };
  await assert.rejects(f.api.act(request), error => error.code === 'adb');
  assert.equal(f.state.inputs, 1);
  assert.equal(f.state.screenshots, 1);
  assert.deepEqual(f.waits, []);
  await assert.rejects(f.api.act(request), error => error.code === 'observation');
  assert.equal(f.state.inputs, 1);
});

test('non-tap actions retain their existing input behavior without extra screenshots', async () => {
  const f = fixture();
  const view = await f.observe();
  const result = await f.api.act({ key: KEY, observationId: view.observationId, action: 'key', button: 'back' });
  assert.equal(result.actionIssued, true);
  assert.equal(result.effectConfirmed, false);
  assert.equal(result.feedback, undefined);
  assert.equal(result.execution.button, 'back');
  assert.equal(f.state.screenshots, 1);
  assert.deepEqual(f.waits, []);
  assert.deepEqual(f.calls.filter(c => c[0] === 'input'), [['input', 'keyevent', '4']]);
});
