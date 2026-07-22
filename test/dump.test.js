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
