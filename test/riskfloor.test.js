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

// The reported FORAI case: lpBurned 0 / lpLocked 0, nothing actually happening,
// and the model still returned CRITICAL on its own.
const forai = {
  audit: { danger: false, critical: false },
  safety: { taxSell: 0, lpBurned: 0, lpLocked: 0, top10: 18 },
  flow: { devSold: false, sniperNetUsd: 0, buyRatio: 0.62, top3TraderShare: 0.26 },
  price: { changePct1m: -0.7, changePct5m: -1.2 }
};

test('capability without an event caps the level at medium', () => {
  const cap = F().ceiling(forai, settings);
  assert.equal(cap.level, 'medium');
  assert.match(cap.reason, /baseline for every token here/);

  const out = F().apply({ risk: 'critical', headline: 'LP can be pulled' }, forai, settings);
  assert.equal(out.risk, 'medium');
  assert.equal(out.loweredFrom, 'critical');
  assert.match(out.loweredReason, /no hazard is actually happening yet/);
  assert.equal(out.raisedReason, undefined);
});

test('an observable event lifts the cap so real danger still reads high', () => {
  const cases = [
    ['the creator is selling', { ...forai, flow: { ...forai.flow, devSold: true } }],
    ['snipers are dumping', { ...forai, flow: { ...forai.flow, sniperNetUsd: -800 } }],
    ['the price is already falling', { ...forai, price: { changePct5m: -12 } }],
    ['the audit flags the contract', { ...forai, audit: { danger: true } }],
    ['the sell tax blocks the exit', { ...forai, safety: { ...forai.safety, taxSell: 30 } }]
  ];
  for (const [label, snapshot] of cases) {
    assert.equal(F().ceiling(snapshot, settings), null, label);
    assert.equal(
      F().apply({ risk: 'critical' }, snapshot, settings).risk, 'critical', label
    );
  }
});

test('the two bounds never contradict each other', () => {
  // Every floor condition is also an active hazard, except unprotected LP,
  // whose floor equals the cap — so no snapshot can demand both a raise and a
  // cap that cross.
  const snapshots = [
    forai,
    { ...forai, audit: { danger: true } },
    { ...forai, safety: { ...forai.safety, taxSell: 30 } },
    { safety: {} },
    {}
  ];
  for (const snapshot of snapshots) {
    const floor = F().evaluate(snapshot, settings);
    const cap = F().ceiling(snapshot, settings);
    if (!floor || !cap) continue;
    assert.ok(
      F().LEVELS.indexOf(floor.level) <= F().LEVELS.indexOf(cap.level),
      `floor ${floor.level} must not exceed cap ${cap.level}`
    );
  }
});

test('a verdict already inside both bounds is returned untouched', () => {
  const verdict = { risk: 'medium', headline: 'ordinary token' };
  assert.equal(F().apply(verdict, forai, settings), verdict);
  // Low is below the LP floor, so it is raised rather than left alone.
  const low = F().apply({ risk: 'low' }, forai, settings);
  assert.equal(low.risk, 'medium');
  assert.match(low.raisedReason, /neither burned nor locked/);
});

test('the cap is off when the floor switch is off', () => {
  const off = { ...settings, riskFloorEnabled: false };
  assert.equal(F().apply({ risk: 'critical' }, forai, off).risk, 'critical');
});

test('without tape data there is no cap, so a partial snapshot is not downgraded', () => {
  // "Nothing is happening" cannot be asserted from a snapshot that carries
  // neither flow nor price; leaving the model's level alone is the honest read.
  assert.equal(F().ceiling({ safety: { lpBurned: 0, lpLocked: 0 } }, settings), null);
  assert.equal(F().ceiling({ audit: { danger: false } }, settings), null);
  assert.equal(F().ceiling({}, settings), null);
  assert.equal(F().apply({ risk: 'critical' }, { safety: { top10: 20 } }, settings).risk,
    'critical');
  // An empty flow object is still evidence the tape was read.
  assert.equal(F().ceiling({ flow: {} }, settings).level, 'medium');
});

test('top holders selling lifts the cap so a real dump reads high', () => {
  // The FORAI baseline is quiet; add the biggest holders actually selling.
  const twoSelling = { ...forai, holders: { topHoldersSelling: 2, topHoldersNetUsd: -100 } };
  assert.equal(F().ceiling(twoSelling, settings), null);
  assert.equal(F().apply({ risk: 'high' }, twoSelling, settings).risk, 'high');

  // One seller dumping past the threshold also counts.
  const bigNet = { ...forai, holders: { topHoldersSelling: 1, topHoldersNetUsd: -900 } };
  assert.equal(F().ceiling(bigNet, settings), null);

  // A single small top-holder sell is not enough to lift the cap.
  const tiny = { ...forai, holders: { topHoldersSelling: 1, topHoldersNetUsd: -50 } };
  assert.equal(F().ceiling(tiny, settings).level, 'medium');
});
