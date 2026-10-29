import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { detectProtectedScreen } from './android-phone-screen.js';
import { buildPhoneTargets, selectPhoneTarget } from './android-phone-targets.js';
import { capturePhoneActionFeedback } from './android-phone-feedback.js';

const executeFile = promisify(execFile);
const OBSERVATION_TTL_MS = 120_000;
const UI_PATH = '/sdcard/qq-fish-window.xml';
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const KEY_CODES = Object.freeze({ home: 3, back: 4, enter: 66, recent: 187, wake: 224, volume_up: 24, volume_down: 25 });
const ERROR_TEXT = {
  disabled: '手机控制尚未启用。',
  owner: '手机只能由主人私聊中的会话使用。',
  config: '手机连接配置不完整，请检查固定设备和 ADB 路径。',
  changed: '手机连接配置已变化，请重新查看手机。',
  adb: '手机 ADB 操作未完成，请检查调试连接后重新查看。',
  timeout: '手机操作超时，请重新查看手机后再试。',
  disconnected: '指定的备用手机当前未建立 ADB 调试连接。',
  observation: '请先重新查看手机，使用最近两分钟内的 observationId；每次操作只能使用一次。',
  coordinates: '坐标必须是当前截图范围内的整数。',
  visual: '坐标预览暂时不可用，未发送点击。请重试观察或使用已识别的文字目标。',
  visual_region_small: '选取的局部区域太小或太窄，无法显示清楚的坐标尺。请重新观察全图后选取更大的局部区域。未发送点击。',
  region: '局部观察须同时传最新observationId和region；region是上一张返回图0~1000范围内的局部矩形，不能使用全图。',
  coordinate_confirmation: '未发送点击。无文字目标先用action=aim，x/y按当前返回图的0~1000刻度，并说明targetDescription；看准星确实落在目标内后，用action=tap_aimed和返回的aimId确认。小目标先observe(observationId,region)放大，不能直接猜原图坐标。',
  focus_required: '未发送点击。无文字目标须先observe(observationId,region)局部放大，当前view.region面积须不超过原图一半，再按新图刻度aim。请把目标及周围上下文一起框入，不要只裁一个像素边缘。',
  aim: '点击预览已失效或aimId不匹配。请用最新观察重新aim，并看图核对准星后再tap_aimed。',
  target_changed: '预览后落点附近画面或屏幕尺寸发生变化，未发送点击。请重新observe并定位，不复用旧坐标。',
  action: '不支持此手机操作。',
  text: '输入内容必须是 1 到 500 个字符，且不能包含空字符。',
  unicode: '当前手机中文输入组件尚未连接，请先接通剪贴板输入。',
  package: '应用包名无效，或该应用没有可启动的主界面。',
  image: '未取得有效的手机截图，原因尚未确认。请检查当前页面或连接，不要连续反复截屏。',
  screen_protected: '当前页面开启了系统防截屏保护（FLAG_SECURE），无法取得画面；手机仍可能正常在线。反复截图、唤醒或修改密码不能解决。停止重试和猜坐标操作，请设备所有者直接在手机上处理或退出这个页面，再重新观察。',
  dimension: '无法确认手机画面尺寸，请重新查看。',
  screenshot_disabled: '手机截图发送尚未接通。当前只能查看截图，不能发送到 QQ。',
  screenshot_send: '截图确认未发送，可使用同一 observationId 重试。',
  screenshot_uncertain: '截图发送结果未确认，不能重复发送这次截图。请先核对 QQ 是否收到。'
};

export class AndroidPhoneError extends Error {
  constructor(code) { super(ERROR_TEXT[code] || ERROR_TEXT.adb); this.name = 'AndroidPhoneError'; this.code = code; }
}
function fail(code) { throw new AndroidPhoneError(code); }
function output(result) {
  if (Buffer.isBuffer(result?.stdout)) return result.stdout;
  if (typeof result?.stdout === 'string') return Buffer.from(result.stdout, 'utf8');
  return Buffer.alloc(0);
}
function quoteShellArgument(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function validPackage(value) { return typeof value === 'string' && value.length <= 200 && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(value); }
function dimensions(text) {
  const matches = [...String(text).matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
  const match = matches.at(-1);
  const width = Number(match?.[1]), height = Number(match?.[2]);
  return validDimension(width) && validDimension(height) ? { width, height } : null;
}
function validDimension(value) { return Number.isSafeInteger(value) && value > 0 && value <= 16_384; }
function pngDimensions(buffer) {
  if (buffer.length < 33 || buffer.length > MAX_SCREENSHOT_BYTES
    || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || buffer.toString('ascii', 12, 16) !== 'IHDR') fail('image');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!validDimension(width) || !validDimension(height)) fail('image');
  return { width, height };
}
function decodeXml(value) {
  return String(value).replace(/&(#x[\da-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (all, code) => {
    const named = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
    if (named[code]) return named[code];
    const n = code[0] === '#' ? (code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : NaN;
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : all;
  });
}
function hierarchyNodes(xml, width, height) {
  const nodes = [];
  let total = 0;
  for (const match of String(xml).matchAll(/<node\b([^>]*)>/g)) {
    const attrs = {};
    for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]] = decodeXml(attr[2]);
    const bound = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds || '');
    if (!bound) continue;
    const [left, top, right, bottom] = bound.slice(1).map(Number);
    if (left >= right || top >= bottom || left >= width || top >= height) continue;
    if (!attrs.text && !attrs['content-desc'] && attrs.clickable !== 'true'
      && attrs.focusable !== 'true' && attrs.scrollable !== 'true') continue;
    total++;
    if (nodes.length >= 100) continue;
    nodes.push({ text: (attrs.text || '').slice(0, 350), description: (attrs['content-desc'] || '').slice(0, 350),
      resourceId: (attrs['resource-id'] || '').slice(0, 200), className: (attrs.class || '').slice(0, 150),
      clickable: attrs.clickable === 'true', enabled: attrs.enabled !== 'false', focused: attrs.focused === 'true',
      scrollable: attrs.scrollable === 'true', bounds: { left, top, right: Math.min(right, width), bottom: Math.min(bottom, height) } });
  }
  return { nodes, nodesTruncated: total > nodes.length };
}

/** Fixed-device, owner-private-only phone access. Every method is serialized. */
export function createAndroidPhoneService({ config, run = executeFile, setText, sendScreenshot, resolveImage, recognizeText, renderVisual, now = Date.now, wait } = {}) {
  let queue = Promise.resolve();
  let observation = null;

  function current(key) {
    let cfg;
    try { cfg = config?.(); } catch { fail('config'); }
    if (cfg?.enabled !== true) fail('disabled');
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    if (!ownerQQ || key !== `private:${ownerQQ}`) fail('owner');
    const adbPath = typeof cfg.adbPath === 'string' ? cfg.adbPath.trim() : '';
    const serial = typeof cfg.serial === 'string' ? cfg.serial.trim() : '';
    if (!adbPath || !serial || serial.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(serial)) fail('config');
    return { ownerQQ, adbPath, serial, key };
  }
  function ensureCurrent(cfg) {
    const latest = current(cfg.key);
    if (latest.ownerQQ !== cfg.ownerQQ || latest.adbPath !== cfg.adbPath || latest.serial !== cfg.serial) fail('changed');
  }
  function exclusive(key, work) {
    const promise = queue.then(async () => {
      const cfg = current(key);
      const result = await work(cfg);
      try { ensureCurrent(cfg); }
      catch (error) {
        if (result?.actionIssued !== true) throw error;
        // Configuration can change while collecting post-input evidence. Keep
        // the issued-input fact, but release no image or previous observation.
        return { ok: true, actionIssued: true, effectConfirmed: false, observationRequired: true,
          feedback: { status: 'unavailable', reason: 'authorization_changed', frames: [] },
          hint: '操作输入已提交，随后手机授权或连接配置发生变化，画面已丢弃。应用效果尚未确认，不要重复提交；恢复可用连接后重新观察。' };
      }
      return result;
    });
    queue = promise.catch(() => {});
    return promise;
  }
  async function adb(cfg, args, { timeout = 10_000, maxBuffer = 1024 * 1024 } = {}) {
    ensureCurrent(cfg);
    try {
      const result = await run(cfg.adbPath, ['-s', cfg.serial, ...args],
        { windowsHide: true, shell: false, timeout, maxBuffer, encoding: 'buffer' });
      ensureCurrent(cfg);
      const bytes = output(result);
      if (bytes.length > maxBuffer) fail('adb');
      return bytes;
    } catch (error) {
      if (error instanceof AndroidPhoneError) throw error;
      fail(error?.killed || error?.code === 'ETIMEDOUT' ? 'timeout' : 'adb');
    }
  }
  const shell = (cfg, args, options) => adb(cfg, ['shell', ...args.map(quoteShellArgument)], options);
  async function connected(cfg) {
    try { return (await adb(cfg, ['get-state'], { timeout: 5000, maxBuffer: 4096 })).toString('utf8').trim() === 'device'; }
    catch (error) { if (error instanceof AndroidPhoneError && ['adb', 'timeout'].includes(error.code)) return false; throw error; }
  }
  async function protectedScreen(cfg) {
    try {
      const dump = await shell(cfg, ['dumpsys', 'window', 'windows'], {timeout:5000,maxBuffer:2*1024*1024});
      return detectProtectedScreen(dump.toString('utf8')).protected;
    } catch (error) {
      if (!(error instanceof AndroidPhoneError) || !['adb','timeout'].includes(error.code)) throw error;
      return false; // An unavailable diagnostic must not be misreported as confirmed protection.
    }
  }
  async function requireConnected(cfg) { if (!await connected(cfg)) { observation = null; fail('disconnected'); } }
  function checkObservation(cfg, id) {
    const clock = now();
    if (!observation || typeof id !== 'string' || id !== observation.id || observation.key !== cfg.key
      || observation.serial !== cfg.serial || observation.adbPath !== cfg.adbPath
      || !Number.isFinite(clock) || clock < observation.at || clock - observation.at > OBSERVATION_TTL_MS) fail('observation');
    return observation;
  }
  function consumeObservation() { observation = null; }
  function point(x, y, screen) {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= screen.width || y >= screen.height) fail('coordinates');
  }
  function normalizedPoint(x, y, region) {
    if (![x, y].every(v => Number.isSafeInteger(v) && v >= 0 && v <= 1000)) fail('coordinates');
    return { x: region.x + Math.min(region.width - 1, Math.round(x * region.width / 1000)),
      y: region.y + Math.min(region.height - 1, Math.round(y * region.height / 1000)) };
  }
  function cropRegion(region, screen) {
    if (!region || !['x', 'y', 'width', 'height'].every(k => Number.isSafeInteger(region[k]))
      || Object.keys(region).some(k => !['x', 'y', 'width', 'height'].includes(k))
      || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
      || region.x + region.width > 1000 || region.y + region.height > 1000
      || region.width * region.height >= 1_000_000) fail('region');
    const base = screen.view?.region ?? { x: 0, y: 0, width: screen.width, height: screen.height };
    const x = base.x + Math.floor(region.x * base.width / 1000);
    const y = base.y + Math.floor(region.y * base.height / 1000);
    const right = base.x + Math.ceil((region.x + region.width) * base.width / 1000);
    const bottom = base.y + Math.ceil((region.y + region.height) * base.height / 1000);
    if (x === base.x && y === base.y && right === base.x + base.width && bottom === base.y + base.height) fail('region');
    return { x, y, width: right - x, height: bottom - y };
  }
  function pointContext(screen, location) {
    const nearby = screen.targets.map(target => {
      const b = target.bounds;
      const dx = Math.max(b.left - location.x, 0, location.x - b.right);
      const dy = Math.max(b.top - location.y, 0, location.y - b.bottom);
      const padding = Math.max(8, Math.min(40, (b.bottom - b.top) * .25));
      return { text: target.text, bounds: b, distance: Math.round(Math.hypot(dx, dy)),
        atPoint: dx <= padding && dy <= padding };
    }).sort((a, b) => a.distance - b.distance);
    return { textAtPoint: nearby.filter(t => t.atPoint).slice(0, 8).map(({atPoint, ...t}) => t),
      nearbyText: nearby.slice(0, 3).map(({atPoint, ...t}) => t),
      hint: '以上是原始截图实测文字及距落点距离。若任务需要空格而textAtPoint显示数字或内容，准星不在空格，不要确认。没有文字也不能单凭OCR认定空格或可点击；仍须看准星与页面规则。' };
  }
  async function visual(png, region, targetPoint) {
    if (typeof renderVisual !== 'function') fail('visual');
    try {
      const result = await renderVisual({ png, region, ...(targetPoint ? { point: targetPoint } : {}) });
      if (!result?.image?.data || result.image.mimeType !== 'image/png'
        || result.view?.coordinateSpace !== 'view_normalized_1000'
        || !['x', 'y', 'width', 'height'].every(k => result.view.region?.[k] === region[k])) fail('visual');
      return result;
    } catch (error) {
      if (error instanceof AndroidPhoneError) throw error;
      fail(error?.code === 'visual_region_small' ? 'visual_region_small' : 'visual');
    }
  }
  async function launcherComponent(cfg, packageName) {
    if (!validPackage(packageName)) fail('package');
    const text = (await shell(cfg, ['cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN',
      '-c', 'android.intent.category.LAUNCHER', '-p', packageName], { maxBuffer: 64 * 1024 })).toString('utf8');
    const component = text.split(/\r?\n/).map(line => line.trim())
      .find(line => line.startsWith(`${packageName}/`) && /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(line));
    if (!component) fail('package');
    return component;
  }

  return {
    saveImage({ key, messageId, imageIndex = 1, imageId } = {}) {
      return exclusive(key, async cfg => {
        if (typeof resolveImage !== 'function') throw new Error('图片保存尚未接通');
        if ((typeof messageId === 'string') === (typeof imageId === 'string')
          || (messageId !== undefined && !/^-?[1-9]\d*$/.test(messageId))
          || (imageId !== undefined && (!imageId || imageId.length > 100))
          || !Number.isInteger(imageIndex) || imageIndex < 1 || imageIndex > 10) throw new Error('请选择当前私聊消息的图片，或已预览的网络图片');
        await requireConnected(cfg);
        const bytes = await resolveImage({ key, messageId, imageIndex, imageId });
        if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > MAX_SCREENSHOT_BYTES) fail('image');
        const ext = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png'
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg'
          : /^GIF8[79]a$/.test(bytes.toString('ascii',0,6)) ? 'gif'
          : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' ? 'webp' : null;
        if (!ext) fail('image');
        const hash = createHash('sha256').update(bytes).digest('hex');
        const devicePath = `/sdcard/Pictures/DaFeiYu/${hash}.${ext}`;
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-phone-image-'));
        try {
          const local = path.join(directory, 'image.' + ext); fs.writeFileSync(local, bytes);
          await shell(cfg, ['mkdir', '-p', '/sdcard/Pictures/DaFeiYu']);
          await adb(cfg, ['push', local, devicePath], { timeout: 30_000, maxBuffer: 16_384 });
          const check = (await shell(cfg, ['sha256sum', devicePath], { maxBuffer: 4096 })).toString('utf8');
          if (!check.startsWith(hash + ' ')) throw new Error('手机上的图片校验失败');
          await shell(cfg, ['am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', 'file://' + devicePath]);
          let galleryIndexed = false;
          // MediaStore canonicalizes /sdcard to /storage/emulated/0. Match the
          // deterministic name and our album suffix instead of the symlink.
          for (let attempt = 0; attempt < 4 && !galleryIndexed; attempt++) {
            if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
            const indexed = (await shell(cfg, ['content', 'query', '--uri', 'content://media/external/images/media',
              '--projection', '_id:_data', '--where', `_display_name='${hash}.${ext}'`], { maxBuffer: 8192 })).toString('utf8');
            galleryIndexed = indexed.includes(`/Pictures/DaFeiYu/${hash}.${ext}`);
          }
          consumeObservation();
          return { saved: true, galleryIndexed, devicePath, sha256: hash,
            hint: '已保存手机图片文件；相册索引若尚未出现，稍后重新打开相册。二维码能否从相册识别由对应应用决定。' };
        } finally {
          const resolved = path.resolve(directory);
          if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('fish-phone-image-')) throw new Error('临时图片目录无效');
          fs.rmSync(resolved, { recursive: true, force: true });
        }
      });
    },
    status({ key } = {}) {
      return exclusive(key, async cfg => {
        if (!await connected(cfg)) { observation = null; return { connected: false, serial: cfg.serial }; }
        const model = (await shell(cfg, ['getprop', 'ro.product.model'], { maxBuffer: 4096 })).toString('utf8').trim().slice(0, 120);
        const androidVersion = (await shell(cfg, ['getprop', 'ro.build.version.release'], { maxBuffer: 4096 })).toString('utf8').trim().slice(0, 40);
        const size = dimensions((await shell(cfg, ['wm', 'size'], { maxBuffer: 4096 })).toString('utf8'));
        return { connected: true, serial: cfg.serial, model, androidVersion, ...(size || {}) };
      });
    },
    apps({ key } = {}) {
      return exclusive(key, async cfg => {
        await requireConnected(cfg);
        const text = (await shell(cfg, ['cmd', 'package', 'query-activities', '--brief', '-a', 'android.intent.action.MAIN',
          '-c', 'android.intent.category.LAUNCHER'], { maxBuffer: 512 * 1024 })).toString('utf8');
        const packages = new Set();
        for (const line of text.split(/\r?\n/)) {
          const match = /^([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+$/.exec(line.trim());
          if (match && validPackage(match[1])) packages.add(match[1]);
        }
        const all = [...packages].sort();
        return { apps: all.slice(0, 200).map(packageName => ({ packageName })), truncated: all.length > 200 };
      });
    },
    observe({ key, observationId, region } = {}) {
      return exclusive(key, async cfg => {
        if ((observationId !== undefined) !== (region !== undefined)) fail('region');
        const previous = region === undefined ? null : checkObservation(cfg, observationId);
        const requestedRegion = previous ? cropRegion(region, previous) : null;
        observation = null;
        await requireConnected(cfg);
        if (await protectedScreen(cfg)) fail('screen_protected');
        let xml = '', hierarchyUnavailable = false;
        try {
          const dump = (await shell(cfg, ['uiautomator', 'dump', UI_PATH], { timeout: 20_000, maxBuffer: 64 * 1024 })).toString('utf8');
          if (!dump.includes('dumped to:') || !dump.includes(UI_PATH)) hierarchyUnavailable = true;
          else {
            xml = (await shell(cfg, ['cat', UI_PATH], { maxBuffer: 2 * 1024 * 1024 })).toString('utf8');
            if (!xml.includes('<hierarchy')) hierarchyUnavailable = true;
          }
        } catch (error) {
          if (!(error instanceof AndroidPhoneError) || !['adb', 'timeout'].includes(error.code)) throw error;
          hierarchyUnavailable = true;
        }
        let png, size;
        try {
          png = await adb(cfg, ['exec-out', 'screencap', '-p'], { maxBuffer: MAX_SCREENSHOT_BYTES });
          size = pngDimensions(png);
        } catch (error) {
          // A password/payment sheet may appear after the initial window check.
          if (error instanceof AndroidPhoneError && ['image','adb','timeout'].includes(error.code) && await protectedScreen(cfg)) fail('screen_protected');
          throw error;
        }
        if (await protectedScreen(cfg)) fail('screen_protected');
        if (previous && (previous.width !== size.width || previous.height !== size.height)) fail('target_changed');
        const at = now();
        if (!Number.isFinite(at)) fail('observation');
        const id = randomUUID();
        // Keep only the latest original PNG, in memory. It is never projected
        // into metadata or exposed as a caller-selected file/path/URL.
        const hierarchy = hierarchyNodes(hierarchyUnavailable ? '' : xml, size.width, size.height);
        let ocrNodes = [];
        if (typeof recognizeText === 'function') {
          try { ocrNodes = (await recognizeText(png)).filter(n=>n && typeof n.text==='string' && n.text.trim()
            && n.bounds && Number.isInteger(n.bounds.left) && Number.isInteger(n.bounds.top)
            && n.bounds.left>=0 && n.bounds.top>=0 && n.bounds.right>n.bounds.left && n.bounds.bottom>n.bounds.top
            && n.bounds.right<=size.width && n.bounds.bottom<=size.height).slice(0,100); } catch {}
        }
        const targets = buildPhoneTargets({ ...hierarchy, ocrNodes, ...size, observationId: id });
        const viewRegion = requestedRegion ?? { x: 0, y: 0, ...size };
        // Text targeting can still operate if visual rendering is unavailable;
        // coordinate input always requires a successfully rendered preview.
        let rendered;
        if (typeof renderVisual === 'function') rendered = await visual(png, viewRegion);
        else if (requestedRegion) fail('visual');
        observation = { id, at, key: cfg.key, serial: cfg.serial, adbPath: cfg.adbPath, ...size, png: Buffer.from(png), targets,
          view: rendered?.view ?? { ...size, region: viewRegion, coordinateSpace: 'original_screenshot_pixels' } };
        return { observationId: id, expiresAt: at + OBSERVATION_TTL_MS, ...size,
          image: rendered?.image ?? { mimeType: 'image/png', data: png.toString('base64') },
          view: observation.view,
          ...hierarchy, ocrNodes, hierarchyUnavailable, targets,
          targetCoordinates: { space: 'original_screenshot_pixels', width: size.width, height: size.height },
          actionHint: '文字用tap_text和最新targets；同名须传targetId。无文字先aim(x,y,targetDescription)，x/y只看当前返回图0~1000刻度，不用原图像素、不手工换算。看准星在目标中心且满足页面规则后tap_aimed(aimId)。小目标先observe(observationId,region)局部放大，region也是当前图0~1000范围。width/height和targets仍属原始手机像素；view.region映射由程序处理。空格需确认没有数字或占用；旧坐标不得跨页复用。actionIssued不证明应用成功，需核对最终变化。' };
      });
    },
    shareScreenshot({ key, observationId } = {}) {
      return exclusive(key, async cfg => {
        const screen = checkObservation(cfg, observationId);
        if (typeof sendScreenshot !== 'function') fail('screenshot_disabled');
        const metadata = { observationId: screen.id, width: screen.width, height: screen.height, capturedAt: screen.at };
        const uncertain = () => ({ sent: false, status: 'uncertain', ...metadata, error: ERROR_TEXT.screenshot_uncertain });
        if (screen.screenshotDelivery?.status === 'sent') {
          return { sent: true, status: 'sent', messageId: screen.screenshotDelivery.messageId, ...metadata, duplicate: true };
        }
        if (screen.screenshotDelivery) return uncertain();

        ensureCurrent(cfg);
        screen.screenshotDelivery = { status: 'sending' };
        try {
          const receipt = await sendScreenshot({ key: cfg.key, png: Buffer.from(screen.png),
            width: screen.width, height: screen.height, observationId: screen.id });
          const messageId = receipt !== null && typeof receipt === 'object' ? receipt.messageId : receipt;
          if (receipt?.ok === false || receipt?.sent === false
            || (typeof messageId !== 'string' && !Number.isSafeInteger(messageId))
            || !/^-?[1-9]\d*$/.test(String(messageId))) throw new Error('unconfirmed receipt');
          screen.screenshotDelivery = { status: 'sent', messageId: String(messageId) };
          return { sent: true, status: 'sent', messageId: String(messageId), ...metadata, duplicate: false };
        } catch (error) {
          if (error?.definite === true) {
            screen.screenshotDelivery = null;
            fail('screenshot_send');
          }
          // A timeout or malformed receipt may follow an actual QQ send. Keep
          // the attempt closed instead of risking a duplicate through a retry.
          screen.screenshotDelivery = { status: 'uncertain' };
          return uncertain();
        }
      });
    },
    openApp({ key, packageName, observationId } = {}) {
      return exclusive(key, async cfg => {
        checkObservation(cfg, observationId);
        if (!validPackage(packageName)) fail('package');
        await requireConnected(cfg);
        const component = await launcherComponent(cfg, packageName);
        checkObservation(cfg, observationId);
        consumeObservation();
        const result = (await shell(cfg, ['am', 'start', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER',
          '-n', component], { timeout: 15_000, maxBuffer: 64 * 1024 })).toString('utf8');
        if (/\b(?:Error|Exception)\b/i.test(result)) fail('package');
        return { ok: true, observationRequired: true };
      });
    },
    act({ key, observationId, action, x, y, x1, y1, x2, y2, durationMs = 300, button, text, targetText, targetId, aimId, targetDescription } = {}) {
      return exclusive(key, async cfg => {
        const screen = checkObservation(cfg, observationId);
        let args;
        if (targetId !== undefined && action !== 'tap_text') fail('action');
        if (targetText !== undefined && action !== 'tap_text') fail('action');
        if (aimId !== undefined && action !== 'tap_aimed') fail('action');
        if (targetDescription !== undefined && action !== 'aim') fail('action');
        if (action === 'aim') {
          // A failed replacement also invalidates the old preview, so it cannot
          // accidentally be confirmed after a rejected attempt to move it.
          screen.aim = null;
          if ([x1,y1,x2,y2,button,text].some(v => v !== undefined)
            || typeof targetDescription !== 'string' || !targetDescription.trim() || targetDescription.length > 160) fail('action');
          if (screen.view?.coordinateSpace !== 'view_normalized_1000') fail('visual');
          if (screen.view.region.width * screen.view.region.height > screen.width * screen.height / 2) fail('focus_required');
          const targetPoint = normalizedPoint(x, y, screen.view.region);
          const rendered = await visual(screen.png, screen.view.region, targetPoint);
          checkObservation(cfg, observationId);
          const plan = { id: randomUUID(), point: targetPoint, targetDescription: targetDescription.trim() };
          screen.aim = plan;
          return { ok: true, actionIssued: false, effectConfirmed: false, observationRequired: false,
            observationId: screen.id, aimId: plan.id, targetDescription: plan.targetDescription,
            pointContext: pointContext(screen, plan.point),
            point: plan.point, coordinateSpace: 'original_phone_screenshot', ...rendered,
            hint: '这是点击前准星预览，没有发送任何输入。确认准星中心确实位于所需目标、空格未被占用且符合页面规则，再用同一observationId和aimId调用tap_aimed。位置不对就重新aim；看不清先observe局部放大。不能仅因生成了准星就认定定位正确。' };
        }
        if (action === 'tap_text') {
          if ([x, y, x1, y1, x2, y2].some(value => value !== undefined)) fail('action');
          const target = selectPhoneTarget(screen.targets, { targetText, targetId });
          args = ['input', 'tap', target.center.x, target.center.y];
        }
        else if (action === 'tap_aimed') {
          if ([x,y,x1,y1,x2,y2,button,text].some(v => v !== undefined)) fail('action');
          if (typeof aimId !== 'string' || !screen.aim || screen.aim.id !== aimId) fail('aim');
          if (typeof renderVisual?.compare !== 'function') fail('visual');
          args = ['input', 'tap', screen.aim.point.x, screen.aim.point.y];
        }
        else if (action === 'tap_normalized') {
          normalizedPoint(x, y, { x: 0, y: 0, width: screen.width, height: screen.height });
          fail('coordinate_confirmation');
        }
        else if (action === 'tap') { point(x, y, screen); fail('coordinate_confirmation'); }
        else if (action === 'swipe') {
          point(x1, y1, screen); point(x2, y2, screen);
          if (!Number.isSafeInteger(durationMs) || durationMs < 50 || durationMs > 5000) fail('action');
          args = ['input', 'swipe', x1, y1, x2, y2, durationMs];
        } else if (action === 'key') {
          if (!Object.hasOwn(KEY_CODES, button)) fail('action');
          args = ['input', 'keyevent', KEY_CODES[button]];
        } else if (action === 'text') {
          if (typeof text !== 'string' || text.length < 1 || text.length > 500 || text.includes('\0')) fail('text');
          if (typeof setText !== 'function') {
            // Android's built-in text input is ASCII-only and translates %s to a
            // space, so ambiguous literal %s and control characters need clipboard.
            if (!/^[\x20-\x7e]+$/.test(text) || text.includes('%s')) fail('unicode');
            args = ['input', 'text', text.replaceAll(' ', '%s')];
          }
        } else fail('action');
        await requireConnected(cfg);
        checkObservation(cfg, observationId);
        if (action === 'tap_aimed') {
          if (await protectedScreen(cfg)) { consumeObservation(); fail('screen_protected'); }
          const fresh = await adb(cfg, ['exec-out', 'screencap', '-p'], { maxBuffer: MAX_SCREENSHOT_BYTES });
          const freshSize = pngDimensions(fresh);
          if (await protectedScreen(cfg)) { consumeObservation(); fail('screen_protected'); }
          if (freshSize.width !== screen.width || freshSize.height !== screen.height) { consumeObservation(); fail('target_changed'); }
          let comparison;
          try { comparison = await renderVisual.compare({ before: screen.png, after: fresh, point: screen.aim.point }); }
          catch { screen.aim = null; fail('visual'); }
          if (comparison?.sameDimensions !== true || comparison?.changed !== false) { consumeObservation(); fail('target_changed'); }
          checkObservation(cfg, observationId);
        }
        consumeObservation();
        if (action === 'text' && typeof setText === 'function') {
          try {
            const result = await setText({ text, serial: cfg.serial });
            if (result?.ok === false) fail('adb');
          }
          catch { fail('adb'); }
        } else await shell(cfg, args);
        const actionCompletedAt = now();
        const execution = { tool: 'phone_action', transport: 'adb', action,
          observationId: screen.id, actionCompletedAt,
          ...(args?.[0] === 'input' && args[1] === 'tap'
            ? { point: { x: Number(args[2]), y: Number(args[3]) }, coordinateSpace: 'original_phone_screenshot' } : {}),
          ...(action === 'tap_text' ? { targetText } : {}),
          ...(action === 'tap_aimed' ? { aimId, targetDescription: screen.aim.targetDescription, previewAcknowledged: true } : {}),
          ...(action === 'key' ? { button } : {}) };
        const feedback = args?.[0] === 'input' && args[1] === 'tap'
          ? await capturePhoneActionFeedback({ now, wait, actionCompletedAt, capture: async () => {
            if (await protectedScreen(cfg)) fail('screen_protected');
            const png = await adb(cfg, ['exec-out', 'screencap', '-p'], { timeout: 5000, maxBuffer: MAX_SCREENSHOT_BYTES });
            const size = pngDimensions(png);
            if (await protectedScreen(cfg)) fail('screen_protected');
            return { png, ...size };
          } }) : undefined;
        return { ok: true, actionIssued: true, effectConfirmed: false, observationRequired: true, execution,
          ...(feedback ? { feedback } : {}),
          hint: '已通过手机ADB执行操作，不是电脑投屏操作；不代表点中了目标或任务成功。检查点击后画面及最终内容，再observe核对；仅返回上一页不能证明保存成功，结果未确认不要重复提交。' };
      });
    }
  };
}
