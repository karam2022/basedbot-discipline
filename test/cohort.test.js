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
load('src/cohort.js');

const C = () => BBD.cohort;
const T0 = 1_700_000_000_000;
const row = (offsetSec, trader, isBuy, volumeUsd = 100) =>
  ({ ts: T0 + offsetSec * 1000, trader, isBuy, volumeUsd });

// Twenty wallets so the sample floor is cleared; the shape is what is asserted.
const wallet = (n) => `0xw${String(n).padStart(38, '0')}`;
const broadTape = () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row(i, wallet(i), true));
  for (let i = 0; i < 20; i++) rows.push(row(200 + i, wallet(i), false));
  return rows;
};

test('a tape below the sample floor reports its size and nothing else', () => {
  const small = C().analyze([
    row(0, wallet(1), true), row(10, wallet(2), true), row(20, wallet(1), false)
  ]);
  assert.equal(small.enough, false);
  assert.equal(small.walletCount, 2);
  // The counts still come back so the panel can say how much tape it has.
  assert.equal(typeof small.observedMin, 'number');
});

test('a short observation window is not enough even with many wallets', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(row(i % 5, wallet(i), true));
  const out = C().analyze(rows);
  assert.equal(out.walletCount, 30);
  // Thirty wallets inside five seconds is a burst, not a history.
  assert.equal(out.enough, false);
});

test('early wallets that later sold are counted as exited', () => {
  const out = C().analyze(broadTape());
  assert.equal(out.enough, true);
  assert.equal(out.walletCount, 20);
  // All twenty first traded inside the 60s early window and all later sold.
  assert.equal(out.earlyWallets, 20);
  assert.equal(out.earlyExitedPct, 100);
});

test('wallets arriving after the early window are outside the cohort', () => {
  const rows = broadTape();
  for (let i = 100; i < 110; i++) rows.push(row(300 + i, wallet(i), true));
  const out = C().analyze(rows);
  assert.equal(out.walletCount, 30);
  assert.equal(out.earlyWallets, 20);
  assert.equal(out.earlyExitedPct, 100);
});

test('a round trip inside the flip window is a flip and sets the hold time', () => {
  const rows = broadTape();
  const out = C().analyze(rows);
  // Each wallet bought at ~0s and sold at ~200s, inside the 5-minute default.
  assert.equal(out.flipperPct, 100);
  assert.ok(out.medianHoldSec >= 195 && out.medianHoldSec <= 205,
    `median hold ${out.medianHoldSec}`);
});

test('a sell with no observed buy is not a flip', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row(i, wallet(i), false));
  for (let i = 0; i < 20; i++) rows.push(row(200 + i, wallet(i), false));
  const out = C().analyze(rows);
  assert.equal(out.enough, true);
  // These wallets may well have bought before the tab was open; claiming a
  // round trip from a sell alone would invent history we never saw.
  assert.equal(out.flipperPct, 0);
  assert.equal(out.medianHoldSec, null);
});

test('a hold longer than the flip window is not counted as a flip', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row(i, wallet(i), true));
  for (let i = 0; i < 20; i++) rows.push(row(600 + i, wallet(i), false));
  const out = C().analyze(rows, { flipWindowMs: 5 * 60 * 1000 });
  assert.equal(out.flipperPct, 0);
});

test('one-trade wallets are the burner signature and are counted separately', () => {
  const rows = [];
  // Fifteen wallets trade once, five trade twice.
  for (let i = 0; i < 15; i++) rows.push(row(i, wallet(i), true));
  for (let i = 15; i < 20; i++) {
    rows.push(row(i, wallet(i), true));
    rows.push(row(150 + i, wallet(i), false));
  }
  const out = C().analyze(rows);
  assert.equal(out.walletCount, 20);
  assert.equal(out.oneTimeWalletPct, 75);
  assert.equal(out.tradesPerWallet, 1.3);
});

test('wallet identity ignores EVM case but preserves base58', () => {
  const mixed = [
    row(0, '0xABCDEF0000000000000000000000000000000001', true),
    row(120, '0xabcdef0000000000000000000000000000000001', false),
    row(1, 'So11111111111111111111111111111111111111112', true),
    row(2, 'so11111111111111111111111111111111111111112', true)
  ];
  const out = C().analyze(mixed);
  // The EVM pair collapses to one wallet; the base58 pair stays two.
  assert.equal(out.walletCount, 3);
});

test('thresholds are configurable and the defaults are exposed', () => {
  const rows = broadTape();
  assert.equal(C().analyze(rows, { minWallets: 50 }).enough, false);
  assert.equal(C().analyze(rows, { minWallets: 5 }).enough, true);
  // A one-second early window admits only the very first wallets.
  const narrow = C().analyze(rows, { earlyWindowMs: 1000, minWallets: 5 });
  assert.ok(narrow.earlyWallets < 20, `early ${narrow.earlyWallets}`);
  assert.equal(C().DEFAULTS.minWallets, 12);
});

test('garbage never throws and returns a well-formed empty result', () => {
  for (const bad of [null, undefined, 'nope', 42, [], [null, undefined, {}]]) {
    const out = C().analyze(bad);
    assert.equal(out.enough, false);
    assert.equal(out.earlyExitedPct, null);
    assert.equal(typeof out.walletCount, 'number');
  }
  // Rows missing a timestamp or trader are skipped rather than poisoning counts.
  const partial = C().analyze([
    { ts: null, trader: wallet(1), isBuy: true },
    { ts: T0, trader: '', isBuy: true },
    row(0, wallet(2), true)
  ]);
  assert.equal(partial.walletCount, 1);
});
