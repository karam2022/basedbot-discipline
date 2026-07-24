const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const load = (rel) => {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  src = src.replace(/const BBD = \{\};/, 'global.BBD = global.BBD || {};');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
};

load('src/constants.js');
load('src/advisor.js');

test('advisor bucket ignores trivial movement inside its coarse bands', () => {
  const first = {
    safety: { top10: 21.1, holders: 4210 },
    flow: { buyRatio: 0.61, devSold: false },
    audit: { danger: false }
  };
  const second = {
    safety: { top10: 24.9, holders: 4999 },
    flow: { buyRatio: 0.64, devSold: false },
    audit: { danger: false }
  };

  assert.equal(BBD.advisor._bucket(first), BBD.advisor._bucket(second));
});

test('advisor bucket changes when risk-relevant signals move materially', () => {
  const calm = {
    safety: { top10: 21, holders: 4200 },
    flow: { buyRatio: 0.6, devSold: false },
    audit: { danger: false }
  };
  const changed = {
    safety: { top10: 41, holders: 420 },
    flow: { buyRatio: 0.3, devSold: true },
    audit: { danger: true }
  };

  assert.notEqual(BBD.advisor._bucket(calm), BBD.advisor._bucket(changed));
});

test('advisor cache freshness expires at the exact ten-minute boundary', () => {
  const now = Date.UTC(2026, 6, 24, 12, 0, 0);
  const entry = {
    verdict: { risk: 'medium' },
    bucket: 'synthetic',
    ts: now - 10 * 60 * 1000 + 1
  };

  assert.equal(BBD.advisor._isFresh(entry, now), true);
  assert.equal(BBD.advisor._isFresh({ ...entry, ts: now - 10 * 60 * 1000 }, now), false);
});
