import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPhoneTargets, selectPhoneTarget } from '../src/android-phone-targets.js';

const box = (left, top, right, bottom) => ({ left, top, right, bottom });
const uia = (text, bounds, enabled = true) => ({ text, bounds, enabled, clickable: true });
const ocr = (text, bounds) => ({ text, bounds, confidence: .99 });
const build = (nodes, ocrNodes, overrides = {}) => buildPhoneTargets({ nodes, ocrNodes,
  width: 1080, height: 2400, observationId: 'offline-observation', ...overrides });

test('reported offset UIA/OCR confirm button resolves to the screenshot OCR center', () => {
  const targets = build([uia('确定', box(864, 2147, 1044, 2197))], [ocr('确定', box(906, 2191, 1000, 2246))]);
  assert.equal(targets.length, 1);
  const target = selectPhoneTarget(targets, { targetText: '确定' });
  assert.equal(target.source, 'ocr');
  assert.deepEqual(target.sources, ['uia', 'ocr']);
  assert.deepEqual(target.center, { x: 953, y: 2219 });
  assert.equal(target.enabled, true);
});

test('two separate same-name buttons remain ambiguous until a current target ID is supplied', () => {
  const targets = build([uia('确定', box(20, 100, 200, 150)), uia('确定', box(20, 600, 200, 650))],
    [ocr('确定', box(70, 110, 150, 140)), ocr('确定', box(70, 610, 150, 640))]);
  assert.equal(targets.length, 2);
  assert.throws(() => selectPhoneTarget(targets, { targetText: '确定' }), { code: 'target_ambiguous' });
  assert.deepEqual(selectPhoneTarget(targets, { targetId: targets[1].id, targetText: '确定' }).center, { x: 110, y: 625 });
});

test('one OCR word overlapping two possible same-name controls is not collapsed arbitrarily', () => {
  const targets = build([uia('确定', box(20, 100, 200, 150)), uia('确定', box(20, 130, 200, 180))],
    [ocr('确定', box(70, 135, 150, 145))]);
  assert.equal(targets.length, 3);
  assert.ok(targets.every(target => !target.sources));
  assert.throws(() => selectPhoneTarget(targets, { targetText: '确定' }), { code: 'target_ambiguous' });
});

test('nearby but nonintersecting same-name labels and separate OCR detections stay separate', () => {
  const separated = build([uia('确定', box(20, 100, 200, 150))], [ocr('确定', box(70, 151, 150, 181))]);
  assert.equal(separated.length, 2);
  const repeatedOcr = build([], [ocr('确定', box(70, 100, 150, 150)), ocr('确定', box(70, 120, 150, 170))]);
  assert.equal(repeatedOcr.length, 2);
  assert.throws(() => selectPhoneTarget(repeatedOcr, { targetText: '确定' }), { code: 'target_ambiguous' });
});

test('disabled UIA state survives merging even when the shifted OCR center is outside its XML box', () => {
  const targets = build([uia('确定', box(864, 2147, 1044, 2197), false)], [ocr('确定', box(906, 2191, 1000, 2246))]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].enabled, false);
  assert.throws(() => selectPhoneTarget(targets, { targetText: '确定', targetId: targets[0].id }), { code: 'target_disabled' });
});

test('OCR cannot sidestep a disabled anonymous control covering its text', () => {
  const targets = build([uia('', box(20, 100, 200, 180), false)], [ocr('确定', box(70, 120, 150, 150))]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].enabled, false);
  assert.throws(() => selectPhoneTarget(targets, { targetText: '确定' }), { code: 'target_disabled' });
});

test('selecting an unmerged OCR ID cannot sidestep a possibly matching disabled control', () => {
  const targets = build([uia('确定', box(864, 2147, 1044, 2197), false), uia('确定', box(870, 2150, 1040, 2200))],
    [ocr('确定', box(906, 2191, 1000, 2246))]);
  const target = targets.find(candidate => candidate.source === 'ocr');
  assert.equal(targets.length, 3);
  assert.ok(!target.sources);
  assert.throws(() => selectPhoneTarget(targets, { targetText: '确定', targetId: target.id }), { code: 'target_disabled' });
});

test('exact duplicate UIA rows cannot override a disabled state', () => {
  const bounds = box(20, 100, 200, 150);
  const targets = build([uia('确定', bounds, false), uia('确定', bounds)], []);
  assert.equal(targets.length, 1);
  assert.throws(() => selectPhoneTarget(targets, { targetText: '确定' }), { code: 'target_disabled' });
});

test('wrong, stale, or mismatched ID fails without selecting a different same-name target', () => {
  const targets = build([], [ocr('确定', box(70, 100, 150, 150))]);
  for (const args of [{ targetId: 'stale', targetText: '确定' }, { targetId: '', targetText: '确定' }])
    assert.throws(() => selectPhoneTarget(targets, args), { code: 'target_id' });
  assert.throws(() => selectPhoneTarget(targets, { targetId: targets[0].id, targetText: '取消' }), { code: 'target_text' });
  assert.throws(() => selectPhoneTarget(targets, { targetId: targets[0].id }), { code: 'target_text' });
});

test('malformed bounds and low-confidence OCR do not create clickable candidates', () => {
  const targets = build([], [ocr('外部', box(1000, 100, 1081, 200)), ocr('小数', box(.5, 100, 150, 150)),
    ocr('空框', box(70, 100, 70, 150)), { ...ocr('不确定', box(70, 100, 150, 150)), confidence: .5 }]);
  assert.deepEqual(targets, []);
});

test('OCR-only targets keep numeric labels and report enabled as unknown', () => {
  const targets = build([], [ocr(' 7 ', box(1079, 2399, 1080, 2400))]);
  const target = selectPhoneTarget(targets, { targetText: ' 7 ' });
  assert.equal(target.enabled, null);
  assert.deepEqual(target.center, { x: 1079, y: 2399 });
});
