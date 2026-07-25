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
