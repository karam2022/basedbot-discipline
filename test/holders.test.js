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
load('src/holders.js');
const H = () => BBD.holders;

const funder = (n) => `0xf${String(n).padStart(39, '0')}`;
// A book of `count` holders, each 1% of supply and in profit unless overridden.
const book = ({ count = 25, pnl = 100, funders = [] } = {}) => {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      percentage: 1,
      total_pnl_usd: pnl,
      funding_source_address_full: funders[i] || undefined
    });
  }
  return rows;
};

test('a book below the holder floor is not enough', () => {
  const out = H().analyze(book({ count: 10 }));
  assert.equal(out.enough, false);
  assert.equal(out.holderCount, 10);
});

test('the share of holders in profit is measured over rows that carry PnL', () => {
  const rows = book({ count: 25, pnl: 100 });
  for (let i = 0; i < 5; i++) rows[i].total_pnl_usd = -50; // 20 of 25 up
  const out = H().analyze(rows);
  assert.equal(out.enough, true);
  assert.equal(out.inProfitPct, 80);
});

test('profit share stays null when too few rows report PnL', () => {
  const rows = book({ count: 25 }).map((r) => ({ ...r, total_pnl_usd: null }));
  rows[0].total_pnl_usd = 100;
  const out = H().analyze(rows);
  // Only one row has PnL — below the floor, so the percentage is withheld.
  assert.equal(out.inProfitPct, null);
  assert.equal(out.enough, true);
});

test('wallets sharing a funding source form a cluster', () => {
  // Nine wallets from one funder — the split-buy shape seen live at 9.7%.
  const rows = book({ count: 25, funders: Array(9).fill(funder(1)) });
  const out = H().analyze(rows);
  assert.equal(out.topClusterWallets, 9);
  assert.equal(out.topClusterPct, 9);       // 9 × 1% supply each
  assert.equal(out.clusteredWallets, 9);
  assert.equal(out.fundedWallets, 9);
});

test('a funder below the cluster floor is not a cluster', () => {
  const rows = book({ count: 25, funders: [funder(1), funder(1)] }); // only two
  const out = H().analyze(rows, { minClusterWallets: 3 });
  assert.equal(out.topClusterWallets, 0);
  assert.equal(out.topClusterPct, null);
  // The wallets are still counted as funded even when they miss the floor.
  assert.equal(out.fundedWallets, 2);
});

test('the largest cluster wins and every qualifying cluster is summed', () => {
  const funders = [
    ...Array(4).fill(funder(1)),
    ...Array(6).fill(funder(2)),
    ...Array(3).fill(funder(3))
  ];
  const out = H().analyze(book({ count: 25, funders }));
  assert.equal(out.topClusterWallets, 6);
  assert.equal(out.clusteredWallets, 13);   // 4 + 6 + 3
  assert.equal(out.clusteredPct, 13);
});

test('funder identity ignores EVM case', () => {
  const upper = '0xABC0000000000000000000000000000000000001';
  const lower = '0xabc0000000000000000000000000000000000001';
  const funders = [upper, lower, lower];
  const out = H().analyze(book({ count: 25, funders }));
  assert.equal(out.topClusterWallets, 3); // all three collapse to one funder
});

test('a token with no funding data reports no cluster but still analyzes', () => {
  // Two of four live tokens returned zero funding sources — this is expected.
  const out = H().analyze(book({ count: 30 }));
  assert.equal(out.enough, true);
  assert.equal(out.fundedWallets, 0);
  assert.equal(out.topClusterWallets, 0);
  assert.equal(out.topClusterPct, null);
  assert.equal(out.inProfitPct, 100);
});

test('the funding_source_address fallback is honored', () => {
  const rows = book({ count: 25 });
  for (let i = 0; i < 4; i++) {
    delete rows[i].funding_source_address_full;
    rows[i].funding_source_address = funder(7);
  }
  const out = H().analyze(rows);
  assert.equal(out.topClusterWallets, 4);
});

test('numeric strings are accepted for percentage and pnl', () => {
  const rows = book({ count: 25 }).map((r) => ({
    ...r, percentage: '1', total_pnl_usd: '100'
  }));
  for (let i = 0; i < 5; i++) rows[i].total_pnl_usd = '-1';
  const out = H().analyze(rows);
  assert.equal(out.inProfitPct, 80);
});

test('garbage never throws and returns a well-formed empty result', () => {
  for (const bad of [null, undefined, 'x', 7, [], [null, 3, {}]]) {
    const out = H().analyze(bad);
    assert.equal(out.enough, false);
    assert.equal(out.inProfitPct, null);
    assert.equal(out.topClusterWallets, 0);
    assert.equal(typeof out.holderCount, 'number');
  }
  assert.equal(H().DEFAULTS.minClusterWallets, 3);
});

// Feature 3: match the real top-N holder addresses against the rolling tape.
const T0 = 1_700_000_000_000;
const holderAddr = (n) => `0xh${String(n).padStart(39, '0')}`;
const holderList = (n) => Array.from({ length: n }, (_, i) =>
  ({ address: holderAddr(i), rank: i + 1, percentage: 1, total_pnl_usd: 10 }));
const tapeRow = (trader, isBuy, secondsAgo, usd) =>
  ({ ts: T0 - secondsAgo * 1000, trader, isBuy, volumeUsd: usd });

test('trackFlow counts top holders selling in the window', () => {
  const out = H().trackFlow(holderList(10), [
    tapeRow(holderAddr(0), false, 30, 500),
    tapeRow(holderAddr(2), false, 60, 300),
    tapeRow('0xoutsider', false, 10, 9999) // not a top holder — ignored
  ], { topN: 10, now: T0 });
  assert.equal(out.enough, true);
  assert.equal(out.tracked, 10);
  assert.equal(out.sellers, 2);
  assert.equal(out.soldUsd, 800);
  assert.equal(out.netUsd, -800);
});

test('trackFlow respects the topN cutoff by rank', () => {
  // Rank 11 sells but only the top 10 are tracked.
  const list = holderList(15);
  const out = H().trackFlow(list, [tapeRow(holderAddr(10), false, 10, 400)],
    { topN: 10, now: T0 });
  assert.equal(out.tracked, 10);
  assert.equal(out.sellers, 0);
});

test('trackFlow separates buyers from sellers and dedupes a wallet', () => {
  const out = H().trackFlow(holderList(10), [
    tapeRow(holderAddr(0), true, 40, 200),
    tapeRow(holderAddr(0), false, 20, 50), // same holder, both sides
    tapeRow(holderAddr(1), true, 10, 100)
  ], { topN: 10, now: T0 });
  assert.equal(out.buyers, 2);
  assert.equal(out.sellers, 1);
  assert.equal(out.netUsd, 250); // 300 bought - 50 sold
});

test('trackFlow ignores trades outside the window', () => {
  const out = H().trackFlow(holderList(10), [
    tapeRow(holderAddr(0), false, 10, 500),   // inside 5m
    tapeRow(holderAddr(1), false, 600, 900)   // 10m ago, outside
  ], { topN: 10, windowMs: 5 * 60 * 1000, now: T0 });
  assert.equal(out.sellers, 1);
  assert.equal(out.soldUsd, 500);
});

test('trackFlow matches top-holder addresses case-insensitively', () => {
  const list = [{ address: '0xABCDEF0000000000000000000000000000000009', rank: 1, percentage: 1 }];
  const out = H().trackFlow(list, [
    tapeRow('0xabcdef0000000000000000000000000000000009', false, 10, 700)
  ], { topN: 10, now: T0 });
  assert.equal(out.sellers, 1);
  assert.equal(out.soldUsd, 700);
});

test('trackFlow returns not-enough without holders or tape', () => {
  assert.equal(H().trackFlow([], [tapeRow(holderAddr(0), false, 1, 1)], {}).enough, false);
  assert.equal(H().trackFlow(holderList(10), [], {}).enough, false);
  for (const bad of [null, undefined, 'x', 7]) {
    assert.equal(H().trackFlow(bad, bad, {}).enough, false);
  }
  assert.equal(H().TRACK_DEFAULTS.topN, 10);
});
