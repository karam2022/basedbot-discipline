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

BBD.creator = { verdictFor: () => ({ flagged: false, launchCount: 1 }) };
BBD.feed = { statsFor: () => ({ holders: 100 }) };
BBD.store = {
  settings: async () => BBD.DEFAULT_SETTINGS,
  get: async () => ({}),
  set: async () => undefined,
  mergeEntry: async () => undefined
};
load('src/journal.js');
load('src/guard.js');

const pos = (positionKey, pct, sourceTs) => ({
  positionKey,
  addr: '0xabcdef123456',
  symbol: 'SWOGE',
  chain: 'base',
  wallet: '0x111111111111',
  pct,
  sourceTs,
  ts: sourceTs
});

test('re-buy creates a new trade and never overwrites the closed trade', () => {
  const s = BBD.DEFAULT_SETTINGS;
  const key = BBD.positionKey('0xabcdef123456', 'base', '0x111111111111');
  const down = pos(key, -5.687661014542615, 10_000);
  const winner = pos(key, 4.25, 20_000);

  let journal = BBD.journal.reconcileState({}, {}, { [key]: down }, s, 10_000);
  journal = BBD.journal.reconcileState(journal, { [key]: down }, { [key]: winner }, s, 20_000);
  journal = BBD.journal.reconcileState(journal, { [key]: winner }, {}, s, 21_000);

  let entries = Object.values(journal);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'closed');
  assert.equal(entries[0].exitPct, 4.25);

  const rebuy = pos(key, 1.5, 22_000);
  journal = BBD.journal.reconcileState(journal, {}, { [key]: rebuy }, s, 22_000);
  entries = Object.values(journal);
  assert.equal(entries.length, 2);
  assert.equal(entries.filter((e) => e.status === 'closed').length, 1);
  assert.equal(entries.filter((e) => e.status === 'open').length, 1);
  assert.equal(BBD.journal.latestClosedFor(journal, rebuy.addr, rebuy.chain).exitPct, 4.25);
});

test('stale unrealized PnL is not misclassified as a realized loss', () => {
  const s = { ...BBD.DEFAULT_SETTINGS, exitSampleMaxAgeSec: 60 };
  const key = BBD.positionKey('0xabcdef123456', 'base', '0x111111111111');
  const staleLoss = pos(key, -5.687661014542615, 10_000);
  let journal = BBD.journal.reconcileState({}, {}, { [key]: staleLoss }, s, 10_000);
  journal = BBD.journal.reconcileState(journal, { [key]: staleLoss }, {}, s, 130_001);
  const closed = Object.values(journal)[0];
  assert.equal(closed.exitPct, null);
  assert.equal(closed.exitEstimatePct, -5.687661014542615);
  assert.equal(BBD.guard.recentLoss(closed, 60), false);
});

test('legacy v1 exits are migrated as unknown instead of trusted losses', () => {
  const legacy = {
    '0xabcdef123456': {
      symbol: 'SWOGE', chain: 'base', status: 'closed',
      openTs: 1000, closeTs: Date.now() - 60_000, exitPct: -5.687661014542615
    }
  };
  const migrated = Object.values(BBD.journal.normalize(legacy))[0];
  assert.equal(migrated.exitPct, null);
  assert.equal(migrated.exitEstimatePct, -5.687661014542615);
  assert.equal(BBD.guard.recentLoss(migrated, 60), false);
});

test('revenge warning requires a current re-buy and can be dismissed', () => {
  const now = Date.now();
  const addr = '0xabcdef123456';
  const key = BBD.positionKey(addr, 'base', '0x111111111111');
  const tradeId = `${key}@${now - 120_000}`;
  const journal = {
    [tradeId]: {
      tradeId, positionKey: key, addr, chain: 'base', symbol: 'SWOGE',
      status: 'closed', openTs: now - 180_000, closeTs: now - 120_000, exitPct: -5.68
    }
  };
  const settings = { ...BBD.DEFAULT_SETTINGS, revengeWindowMin: 60 };
  assert.equal(BBD.guard.warningFor(journal, {}, {}, addr, 'base', settings), null);
  assert.equal(BBD.guard.warningFor(journal, { [key]: pos(key, 2, now - BBD.STALE_MS - 1) }, {}, addr, 'base', settings), null);
  assert.equal(BBD.guard.warningFor(journal, { [key]: pos(key, 2, now) }, {}, addr, 'base', settings).tradeId, tradeId);
  assert.equal(BBD.guard.warningFor(journal, { [key]: pos(key, 2, now) }, { [tradeId]: now }, addr, 'base', settings), null);
});

test('position identity separates chains and wallets', () => {
  const addr = '0xabcdef123456';
  assert.notEqual(
    BBD.positionKey(addr, 'base', 'wallet1'),
    BBD.positionKey(addr, 'ethereum', 'wallet1')
  );
  assert.notEqual(
    BBD.positionKey(addr, 'base', 'wallet1'),
    BBD.positionKey(addr, 'base', 'wallet2')
  );
});
