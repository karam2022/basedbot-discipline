// Creator reputation model: serial-launcher and rug detection, flag
// thresholds, verdict resolution, and merge-persist. Rug status is never
// stored — it is recomputed from raw market history so threshold changes
// reclassify without migration.
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

const settings = {
  creatorGuardEnabled: true,
  creatorMaxLaunches: 5,
  creatorMaxRugs: 2,
  creatorRugMinPeakUsd: 8000,
  creatorRugDeadLiqUsd: 800
};

// Fresh model + storage per test so cases can't leak into each other.
const fresh = () => {
  const storage = {};
  global.BBD = {
    KEYS: { creators: 'creators' },
    alive: () => true,
    feed: { creatorFor: () => null }, // force verdictFor to use the observed index
    store: {
      async get(key, fallback) { return key in storage ? storage[key] : fallback; },
      async set(key, value) { storage[key] = value; }
    }
  };
  load('src/creator.js');
  return { C: BBD.creator, storage };
};

test('serial launcher is flagged at the launch threshold', () => {
  const { C } = fresh();
  const DEV = '0xdead';
  for (let i = 0; i < 5; i++) C.observe('0xtok' + i, DEV, { mcap: 50000, liq: 20000, symbol: 'T' + i });
  const rep = C.reputation(DEV, settings);
  assert.equal(rep.launchCount, 5);
  assert.equal(rep.ruggedCount, 0);
  assert.equal(rep.flagged, true);
});

test('a rug is counted only after a real peak then a liquidity collapse', () => {
  const { C } = fresh();
  const DEV = '0xc1ean';
  C.observe('0xrug1', DEV, { mcap: 30000, liq: 15000, symbol: 'R1' }); // alive, peak 30k
  assert.equal(C.reputation(DEV, settings).ruggedCount, 0);
  C.observe('0xrug1', DEV, { mcap: 500, liq: 100, symbol: 'R1' });     // collapsed
  const rep = C.reputation(DEV, settings);
  assert.equal(rep.ruggedCount, 1);
  assert.equal(rep.launchCount, 1);
  assert.equal(rep.flagged, false); // one rug is under the threshold
});

test('a low-peak death is not a rug (never had a real market)', () => {
  const { C } = fresh();
  const DEV = '0x10wcap';
  C.observe('0xtiny', DEV, { mcap: 2000, liq: 30, symbol: 'TINY' }); // peak < creatorRugMinPeakUsd
  const rep = C.reputation(DEV, settings);
  assert.equal(rep.ruggedCount, 0);
  assert.equal(rep.flagged, false);
});

test('two rugs flag the creator', () => {
  const { C } = fresh();
  const DEV = '0xc1ean';
  C.observe('0xrug1', DEV, { mcap: 30000, liq: 15000, symbol: 'R1' });
  C.observe('0xrug1', DEV, { mcap: 500, liq: 100, symbol: 'R1' });
  C.observe('0xrug2', DEV, { mcap: 20000, liq: 12000, symbol: 'R2' });
  C.observe('0xrug2', DEV, { mcap: 300, liq: 50, symbol: 'R2' });
  const rep = C.reputation(DEV, settings);
  assert.equal(rep.ruggedCount, 2);
  assert.equal(rep.flagged, true);
});

test('verdictFor resolves the creator via the observed-token index', () => {
  const { C } = fresh();
  const DEV = '0xdead';
  for (let i = 0; i < 5; i++) C.observe('0xtok' + i, DEV, { mcap: 50000, liq: 20000, symbol: 'T' + i });
  const v = C.verdictFor('0xtok0', settings);
  assert.equal(v.creatorAddr, DEV);
  assert.equal(v.flagged, true);
  assert.equal(C.verdictFor('0xunknown', settings).creatorAddr, null);
});

test('disabling the guard never flags anyone', () => {
  const { C } = fresh();
  const DEV = '0xdead';
  for (let i = 0; i < 5; i++) C.observe('0xtok' + i, DEV, { mcap: 50000, liq: 20000, symbol: 'T' + i });
  assert.equal(C.reputation(DEV, { ...settings, creatorGuardEnabled: false }).flagged, false);
});

test('flush persists tokens and peak, but never a stored rug status', async () => {
  const { C, storage } = fresh();
  await new Promise((r) => setTimeout(r, 10)); // let creator.js hydrate() settle before flush merges
  const DEV = '0xdead';
  const CLEAN = '0xc1ean';
  for (let i = 0; i < 5; i++) C.observe('0xtok' + i, DEV, { mcap: 50000, liq: 20000, symbol: 'T' + i });
  C.observe('0xrug1', CLEAN, { mcap: 30000, liq: 15000, symbol: 'R1' });
  C.observe('0xrug1', CLEAN, { mcap: 500, liq: 100, symbol: 'R1' });
  await C.flush();
  assert.equal(typeof storage.creators, 'object');
  assert.equal(Object.keys(storage.creators[DEV].tokens).length, 5);
  assert.ok(!('rugged' in storage.creators[CLEAN].tokens['0xrug1']));
  assert.equal(storage.creators[CLEAN].tokens['0xrug1'].peakMcap, 30000);
});
