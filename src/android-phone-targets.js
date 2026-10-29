// All bounds and centers belong to the original screencap PNG, never its thumbnail.
const MAX_TEXT_LENGTH = 200;

function validBounds(bounds, width, height) {
  return bounds && ['left', 'top', 'right', 'bottom'].every(key => Number.isSafeInteger(bounds[key]))
    && bounds.left >= 0 && bounds.top >= 0 && bounds.left < bounds.right && bounds.top < bounds.bottom
    && bounds.right <= width && bounds.bottom <= height;
}
function center(bounds) {
  return { x: Math.min(bounds.right - 1, Math.round((bounds.left + bounds.right) / 2)),
    y: Math.min(bounds.bottom - 1, Math.round((bounds.top + bounds.bottom) / 2)) };
}
function candidates(nodes, source, width, height) {
  const unique = new Map();
  for (const node of nodes ?? []) {
    const text = typeof node?.text === 'string' ? node.text.trim() : '';
    if (!text || text.length > MAX_TEXT_LENGTH || !validBounds(node.bounds, width, height)) continue;
    if (source === 'ocr' && node.confidence !== undefined
      && (!Number.isFinite(node.confidence) || node.confidence < .65)) continue;
    const bounds = Object.fromEntries(['left', 'top', 'right', 'bottom'].map(key => [key, node.bounds[key]]));
    const key = JSON.stringify([text, bounds]);
    const previous = unique.get(key);
    unique.set(key, { source, text, bounds, center: center(bounds),
      role: source === 'uia' && (node.clickable === true || previous?.role === 'button') ? 'button' : 'text',
      enabled: source === 'uia' ? node.enabled !== false && previous?.enabled !== false : null,
      ...(source === 'ocr' && Number.isFinite(node.confidence) ? { confidence: node.confidence } : {}) });
  }
  return [...unique.values()];
}

function sameVisualLabel(uia, ocr) {
  if (uia.text !== ocr.text) return false;
  const a = uia.bounds, b = ocr.bounds;
  const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const heightA = a.bottom - a.top, heightB = b.bottom - b.top;
  // Require actual intersection and similar line heights, not a nearest-neighbor
  // guess. Wide button bounds may contain a much narrower OCR word.
  return overlapX >= .8 * Math.min(a.right - a.left, b.right - b.left)
    && overlapY >= .1 * Math.min(heightA, heightB)
    && Math.max(heightA, heightB) <= 4 * Math.min(heightA, heightB);
}

/** Merge only mutually unique UIA/OCR matches; retain genuinely repeated labels. */
export function buildPhoneTargets({ nodes = [], ocrNodes = [], width, height, observationId }) {
  const uia = candidates(nodes, 'uia', width, height);
  const ocr = candidates(ocrNodes, 'ocr', width, height);
  const uiaMatches = uia.map(a => ocr.map((b, index) => sameVisualLabel(a, b) ? index : -1).filter(index => index >= 0));
  const ocrMatches = ocr.map(b => uia.map((a, index) => sameVisualLabel(a, b) ? index : -1).filter(index => index >= 0));
  const mergedUia = new Set();
  const disabledBounds = nodes.filter(node => node?.enabled === false && validBounds(node.bounds, width, height)).map(node => node.bounds);
  const targets = ocr.map((candidate, index) => {
    const matches = ocrMatches[index];
    const matched = matches.length === 1 && uiaMatches[matches[0]].length === 1 ? matches[0] : undefined;
    let result = candidate;
    if (matched !== undefined) {
      mergedUia.add(matched);
      // The OCR rectangle was measured on the returned screenshot. Do not select
      // an older XML center when the two sources have a small layout offset.
      result = { ...candidate, sources: ['uia', 'ocr'], role: uia[matched].role, enabled: uia[matched].enabled };
    }
    if (matches.some(uiaIndex => uia[uiaIndex].enabled === false)
      || disabledBounds.some(box => result.center.x >= box.left && result.center.x < box.right
      && result.center.y >= box.top && result.center.y < box.bottom)) result = { ...result, enabled: false };
    return result;
  });
  targets.push(...uia.filter((_, index) => !mergedUia.has(index)));
  return targets.map((target, index) => ({ id: `pt-${observationId}-${index + 1}`, ...target }));
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function selectPhoneTarget(targets, { targetText, targetId } = {}) {
  if (typeof targetText !== 'string' || !targetText.trim() || targetText.length > MAX_TEXT_LENGTH)
    fail('target_text', '请传当前观察 targets 中完整的目标文字 targetText。');
  const text = targetText.trim();
  let target;
  if (targetId !== undefined) {
    if (typeof targetId !== 'string' || !targetId || targetId.length > 100)
      fail('target_id', 'targetId 必须来自本次最新观察的 targets。');
    target = targets.find(candidate => candidate.id === targetId);
    if (!target) fail('target_id', 'targetId 不属于本次最新观察，请重新查看。');
    if (target.text !== text) fail('target_text', 'targetText 必须与所选 targetId 的实际文字一致，不会回退到其他位置。');
  } else {
    const matches = targets.filter(candidate => candidate.text === text);
    if (matches.length !== 1) fail('target_ambiguous', '当前观察未找到唯一的文字位置；同名目标请核对画面并传对应 targetId 和完整 targetText。');
    target = matches[0];
  }
  if (target.enabled === false) fail('target_disabled', '当前目标在界面节点中已禁用，未发送点击；请先确认页面需要满足的条件。');
  return target;
}
