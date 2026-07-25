const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const load = (rel) => {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/const BBD = \{\};/, 'global.BBD = global.BBD || {};');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
};

global.BBD = global.BBD || {};
load('src/riskfloor.js');

const F = () => BBD.riskFloor;
const settings = { scalpMaxSellTaxPct: 10, advisorFloorLpPct: 50 };

test('an unsafe contract floors the level at high', () => {
  const danger = F().evaluate({ audit: { danger: true } }, settings);
  assert.equal(danger.level, 'high');
  assert.match(danger.reason, /contract flagged unsafe/);

  const critical = F().evaluate({ audit: { critical: true } }, settings);
  assert.equal(critical.level, 'high');
});

test('a sell tax above the scalp threshold floors the level at high', () => {
  assert.equal(F().evaluate({ safety: { taxSell: 25 } }, settings).level, 'high');
  // At the threshold a flip is still economic, so it must not floor.
  assert.equal(F().evaluate({ safety: { taxSell: 10 } }, settings), null);
  assert.equal(F().evaluate({ safety: { taxSell: 0 } }, settings), null);
});

test('LP neither burned nor locked floors the level at medium, not high', () => {
  const floor = F().evaluate({ safety: { lpBurned: 0, lpLocked: 0 } }, settings);
  assert.equal(floor.level, 'medium');
  assert.match(floor.reason, /neither burned nor locked/);

  // Either protection alone clears it — the screenshot bug sent only lpBurned.
  assert.equal(F().evaluate({ safety: { lpBurned: 100, lpLocked: 0 } }, settings), null);
  assert.equal(F().evaluate({ safety: { lpBurned: 0, lpLocked: 100 } }, settings), null);
  assert.equal(F().evaluate({ safety: { lpLocked: 50 } }, settings), null);
});

test('unknown LP is not a floor, so a late-loading panel stays quiet', () => {
  assert.equal(F().evaluate({ safety: {} }, settings), null);
  assert.equal(F().evaluate({}, settings), null);
  assert.equal(F().evaluate({ safety: { lpBurned: null, lpLocked: null } }, settings), null);
});

test('the strongest hazard wins when several apply', () => {
  const floor = F().evaluate(
    { audit: { danger: true }, safety: { taxSell: 30, lpBurned: 0, lpLocked: 0 } },
    settings
  );
  assert.equal(floor.level, 'high');
});

test('apply raises a verdict and records that the extension did it', () => {
  const raised = F().apply(
    { risk: 'low', headline: 'looks fine', against: ['x'] },
    { audit: { danger: true } },
    settings
  );
  assert.equal(raised.risk, 'high');
  assert.equal(raised.raisedFrom, 'low');
  assert.match(raised.raisedReason, /contract flagged unsafe/);
  // Everything else survives untouched.
  assert.equal(raised.headline, 'looks fine');
  assert.deepEqual(raised.against, ['x']);
});

test('apply never lowers a level the model set higher', () => {
  const verdict = { risk: 'critical', headline: 'dev is selling' };
  const out = F().apply(verdict, { safety: { lpBurned: 0, lpLocked: 0 } }, settings);
  assert.equal(out.risk, 'critical');
  assert.equal(out.raisedReason, undefined);

  // Equal to the floor is not a raise either.
  const same = F().apply({ risk: 'high' }, { audit: { danger: true } }, settings);
  assert.equal(same.risk, 'high');
  assert.equal(same.raisedReason, undefined);
});

test('apply is a no-op when the floor is switched off', () => {
  const off = { ...settings, riskFloorEnabled: false };
  const out = F().apply({ risk: 'low' }, { audit: { danger: true } }, off);
  assert.equal(out.risk, 'low');
  assert.equal(out.raisedReason, undefined);
});

test('apply survives garbage without dropping the verdict', () => {
  assert.equal(F().apply(null, { audit: { danger: true } }, settings), null);
  assert.equal(F().apply(undefined, null, null), undefined);
  // An unrecognised level ranks below every floor, so it is raised.
  assert.equal(F().apply({ risk: 'weird' }, { audit: { danger: true } }, settings).risk, 'high');
  assert.equal(F().evaluate(null, settings), null);
  assert.equal(F().evaluate('nope', settings), null);
});

test('thresholds follow the settings rather than hard-coded numbers', () => {
  const strict = { scalpMaxSellTaxPct: 3, advisorFloorLpPct: 90 };
  assert.equal(F().evaluate({ safety: { taxSell: 5 } }, strict).level, 'high');
  assert.equal(F().evaluate({ safety: { taxSell: 5 } }, settings), null);
  // 50% burned clears the default but not a 90% requirement.
  assert.equal(F().evaluate({ safety: { lpBurned: 50 } }, settings), null);
  assert.equal(F().evaluate({ safety: { lpBurned: 50 } }, strict).level, 'medium');
  // Missing settings fall back to the documented defaults.
  assert.equal(F().evaluate({ safety: { taxSell: 25 } }, undefined).level, 'high');
});
