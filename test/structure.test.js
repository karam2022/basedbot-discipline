// Structure-break detector: "first lower high after a climax" as a state
// machine. The transitions are the product — pin them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
global.BBD = {
  STALE_MS: 30 * 60 * 1000,
  positionAddr: (key, p) => (p && p.addr) || key
};
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(path.join(ROOT, 'src/structure.js'), 'utf8'));

const ARM = 30;
const run = (series) => {
  let st = null;
  const fires = [];
  for (const pct of series) {
    const r = BBD.structure.step(st, pct, ARM);
    st = r.state;
    if (r.fired) fires.push(pct);
  }
  return { st, fires };
};

test('the canonical break: climax, pullback, lower high, rollover → one fire', () => {
  // peak +60 → pullback to +45 → rebound to +52 (lower high) → roll to +47
  const { fires } = run([10, 30, 60, 50, 45, 49, 52, 47]);
  assert.deepEqual(fires, [47], 'fires exactly once, on the rollover');
});

test('a healthy dip that reclaims the peak never fires', () => {
  // pullback then rebound THROUGH the old peak — uptrend intact
  const { fires, st } = run([10, 40, 60, 50, 46, 55, 62, 58]);
  assert.deepEqual(fires, []);
  assert.equal(st.phase, 'ride');
  assert.equal(st.peak, 62, 'the new peak is now the reference');
});

test('below the arm threshold nothing fires — small moves are noise', () => {
  const { fires } = run([2, 12, 25, 15, 19, 22, 16]); // same shape, peak < 30
  assert.deepEqual(fires, []);
});

test('after firing it stays quiet until a NEW peak re-arms it', () => {
  const series = [10, 60, 45, 50, 45,   40, 35, 38, 33]; // fire at 45, then keep bleeding
  const { fires } = run(series);
  assert.equal(fires.length, 1, 'the bleed after the break does not re-alarm');
  // ...but a fresh all-time high re-arms, and a second break fires again
  const again = run([...series, 70, 55, 60, 54]);
  assert.equal(again.fires.length, 2, 'new peak → new cycle → new fire');
});

test('update(): fires produce banner-shaped alerts and vanish with the position', () => {
  const now = Date.now();
  const pos = (pct) => ({ k1: { positionKey: 'k1', addr: '0xaaa', chain: 'robinhood', symbol: 'RIDE', pct, sourceTs: now } });
  const settings = { structureArmPct: 30 };
  let alerts = [];
  for (const pct of [10, 60, 45, 49, 52, 47]) alerts = BBD.structure.update(pos(pct), settings);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].symbol, 'RIDE');
  assert.equal(alerts[0].peakPct, 60);
  assert.match(alerts[0].actionKey, /^sb:k1:60$/);
  // position sold → machine and alert are gone
  alerts = BBD.structure.update({}, settings);
  assert.deepEqual(alerts, []);
});
