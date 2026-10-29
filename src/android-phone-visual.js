import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_PNG_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MESSAGES = {
  visual_config: '手机坐标画面组件尚未配置。',
  visual_image: '无法读取有效的手机PNG画面。',
  visual_region: '局部区域必须使用原图内的整数x/y/width/height。',
  visual_region_small: '局部区域太窄或太小，无法显示可读坐标尺；请选择较大的区域。',
  visual_point: '落点必须是原图范围内的整数坐标，并位于所选区域内。',
  visual_budget: '坐标画面无法在大小限制内清晰输出，请调整区域。',
  visual_timeout: '手机坐标画面处理超时，请重试。',
  visual_closed: '手机坐标画面组件已关闭。',
  visual_process: '手机坐标画面处理未完成。',
};
function failure(code = 'visual_process') {
  const error = new Error(MESSAGES[code] ?? MESSAGES.visual_process);
  error.code = Object.hasOwn(MESSAGES, code) ? code : 'visual_process';
  return error;
}
function imageData(png) {
  if (!Buffer.isBuffer(png) || png.length < 33 || png.length > MAX_PNG_BYTES
    || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw failure('visual_image');
  return png.toString('base64');
}
function rectangle(region) {
  if (region === undefined) return undefined;
  if (!region || Object.keys(region).sort().join(',') !== 'height,width,x,y'
    || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(region[key]))
    || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1) throw failure('visual_region');
  return { x: region.x, y: region.y, width: region.width, height: region.height };
}
function position(point, required = false) {
  if (point === undefined && !required) return undefined;
  if (!point || Object.keys(point).sort().join(',') !== 'x,y'
    || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) || point.x < 0 || point.y < 0)
    throw failure('visual_point');
  return { x: point.x, y: point.y };
}
function validateResult(value, action) {
  if (action === 'compare') {
    if (!value || typeof value.sameDimensions !== 'boolean' || typeof value.changed !== 'boolean'
      || (value.sameDimensions ? !Number.isFinite(value.difference) || value.difference < 0 || value.difference > 1 : value.difference !== null))
      throw failure();
    return value;
  }
  const view = value?.view, image = value?.image;
  if (!view || !Number.isSafeInteger(view.width) || !Number.isSafeInteger(view.height)
    || view.width < 1 || view.height < 1 || Math.max(view.width, view.height) > 1280 || view.width * view.height > 640000
    || view.coordinateSpace !== 'view_normalized_1000' || image?.mimeType !== 'image/png' || typeof image.data !== 'string') throw failure();
  rectangle(view.region);
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length > 1024 * 1024 || bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(16) !== view.width || bytes.readUInt32BE(20) !== view.height) throw failure();
  return value;
}

/** In-memory rendering only. region/point use original PNG pixels; no padding is added. */
export function createAndroidPhoneVisual({ root, pythonPath } = {}) {
  let worker, pending, output = '', queue = Promise.resolve(), closed = false;
  const onExit = () => worker?.kill();
  process.once('exit', onExit);
  function stop(error = failure()) {
    const own = worker; worker = undefined; output = '';
    own?.kill();
    if (pending) { const current = pending; pending = undefined; clearTimeout(current.timer); current.reject(error); }
  }
  function start() {
    if (closed) throw failure('visual_closed');
    if (worker) return;
    if (typeof root !== 'string' || !root || typeof pythonPath !== 'string' || !pythonPath) throw failure('visual_config');
    worker = spawn(pythonPath, ['-B', '-u', path.join(root, 'scripts', 'phone-visual.py'), path.join(root, '.phone-python-deps')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const own = worker;
    worker.on('error', () => { if (worker === own) stop(); });
    worker.on('exit', () => { if (worker === own) stop(); });
    worker.stdin.on('error', () => { if (worker === own) stop(); });
    worker.stdout.on('data', chunk => {
      if (worker !== own) return;
      output += chunk.toString('utf8');
      if (output.length > 2 * 1024 * 1024) { stop(); return; }
      let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { stop(); return; }
        if (!pending || message.id !== pending.id) { stop(); return; }
        const current = pending; pending = undefined; clearTimeout(current.timer);
        if (message.ok !== true) current.reject(failure(message.code));
        else {
          try { current.resolve(validateResult(message.value, current.action)); } catch (error) { current.reject(error); }
        }
      }
    });
  }
  function request(action, payload) {
    const task = queue.then(() => new Promise((resolve, reject) => {
      try { start(); } catch (error) { reject(error); return; }
      const own = worker, id = randomUUID();
      const timer = setTimeout(() => {
        if (worker === own && pending?.id === id) stop(failure('visual_timeout'));
      }, 15000);
      pending = { id, action, timer, resolve, reject };
      own.stdin.write(JSON.stringify({ id, action, ...payload }) + '\n', error => {
        if (error && worker === own) stop();
      });
    }));
    queue = task.catch(() => {});
    return task;
  }
  const render = async ({ png, region, point } = {}) => request('render', {
    png: imageData(png), region: rectangle(region), point: position(point),
  });
  render.compare = async ({ before, after, point } = {}) => request('compare', {
    before: imageData(before), after: imageData(after), point: position(point, true),
  });
  render.close = () => { closed = true; process.removeListener('exit', onExit); stop(failure('visual_closed')); };
  return render;
}
