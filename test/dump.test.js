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

global.chrome = { runtime: { id: 'test' } };
load('src/constants.js');
BBD.store = {};
BBD.feed = {};
load('src/dump.js');

const now = Date.UTC(2026, 6, 22, 12, 0, 0);
const recent = '2026-07-22 11:59:30';

test('dump detector rejects stale or unparseable timestamps', () => {
  const hits = BBD.dump.detect([
    { is_buy: false, timestamp: 'not-a-date', volume_usd: 5000, tx_hash: 'bad' },
    { is_buy: false, timestamp: '2026-07-22 11:50:00', volume_usd: 5000, tx_hash: 'old' },
    { is_buy: false, timestamp: recent, volume_usd: 5000, tx_hash: 'fresh' }
  ], { creatorAddr: null, whaleSellUsd: 1000, now, windowMs: 3 * 60 * 1000 });
  assert.deepEqual(hits.map((h) => h.txHash), ['fresh']);
});

test('base58 creator comparison remains case-sensitive', () => {
  const creator = 'AbCdEfGhijkLMNPqrstUVwxyz123456789';
  const trades = [{
    is_buy: false, timestamp: recent, volume_usd: 1, tx_hash: 'tx',
    trader_full: creator.toLowerCase()
  }];
  const hits = BBD.dump.detect(trades, {
    creatorAddr: creator, whaleSellUsd: 1000, now, windowMs: 3 * 60 * 1000
  });
  assert.equal(hits.length, 0);
});

const tickHarness = (t, { addr, pool, response }) => {
  const calls = [];
  const warnings = [];
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const originalStore = BBD.store;
  const originalFeed = BBD.feed;
  t.after(() => {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    BBD.store = originalStore;
    BBD.feed = originalFeed;
  });

  BBD.store = {
    settings: async () => ({
      dumpAlertsEnabled: true,
      dumpWindowMin: 3,
      whaleSellUsd: 300,
      whaleSellLiquidityPct: 2
    }),
    get: async () => ({
      [BBD.positionKey(addr, '4663', 'testwallet')]: {
        addr,
        chain: '4663',
        symbol: 'TEST',
        sourceTs: Date.now()
      }
    })
  };
  BBD.feed = {
    poolFor: () => pool,
    marketFor: () => null,
    creatorFor: () => null
  };
  global.fetch = async (...args) => {
    calls.push(args);
    return response;
  };
  console.warn = (...args) => warnings.push(args);
  return { calls, warnings };
};

test('dump tick makes no request when no pool is known', async (t) => {
  const addr = '0x1111111111111111111111111111111111111111';
  const { calls } = tickHarness(t, {
    addr,
    pool: null,
    response: { ok: true, json: async () => ({ data: [] }) }
  });

  await BBD.dump.tick();

  assert.equal(calls.length, 0);
});

test('dump tick sends the known pool and chain in the trades URL', async (t) => {
  const addr = '0x2222222222222222222222222222222222222222';
  const pool = '0x3333333333333333333333333333333333333333';
  const { calls } = tickHarness(t, {
    addr,
    pool: { pool, chain: '4663', ts: Date.now() },
    response: { ok: true, status: 200, json: async () => ({ data: [] }) }
  });

  await BBD.dump.tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `/api/token/${addr}/trades?chain=4663&pool=${pool}`);
  assert.deepEqual(calls[0][1], { credentials: 'same-origin' });
});

test('dump tick warns once per token across repeated 4xx responses', async (t) => {
  const addr = '0x4444444444444444444444444444444444444444';
  const pool = '0x5555555555555555555555555555555555555555';
  const { calls, warnings } = tickHarness(t, {
    addr,
    pool: { pool, chain: '4663', ts: Date.now() },
    response: { ok: false, status: 400 }
  });

  await BBD.dump.tick();
  await BBD.dump.tick();

  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /^\[bbd\].*400/);
  assert.match(warnings[0][0], new RegExp(addr));
});

test('dump tick keeps 5xx responses quiet', async (t) => {
  const addr = '0x6666666666666666666666666666666666666666';
  const pool = '0x7777777777777777777777777777777777777777';
  const { warnings } = tickHarness(t, {
    addr,
    pool: { pool, chain: '4663', ts: Date.now() },
    response: { ok: false, status: 503 }
  });

  await BBD.dump.tick();

  assert.equal(warnings.length, 0);
});
