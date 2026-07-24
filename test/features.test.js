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
load('src/features.js');

const DEV_ADDRESS = '0x1111111111111111111111111111111111111111';
const USER_WALLET = '0x2222222222222222222222222222222222222222';

test('build produces the complete compact snapshot from realistic inputs', () => {
  const snapshot = BBD.features.build({
    symbol: 'AI',
    chain: 'robinhood',
    ageHours: 216,
    market: {
      liq: 543100,
      mcap: 12740000,
      isLaunchpad: false,
      symbol: 'MARKET-FALLBACK',
      volume24hUsd: 10560000
    },
    stats: {
      holders: 4000,
      pro: 50,
      top10: 25,
      dev: 1,
      snipers: 2,
      insiders: 12,
      bundlers: 3,
      paid: false
    },
    intel: {
      top10: 19,
      dev: 0,
      snipers: 0,
      insiders: 9,
      bundlers: 0,
      holders: 5010,
      proTraders: 61,
      dexPaid: true,
      lpBurned: 100,
      lpLocked: 0,
      tokenBurn: 7,
      renounced: true,
      taxBuy: 0,
      taxSell: 2
    },
    audit: {
      danger: false,
      critical: false,
      ownerRenounced: true,
      reasons: []
    },
    creator: {
      creatorAddr: DEV_ADDRESS,
      launchCount: 3,
      ruggedCount: 1,
      flagged: false
    },
    flow: {
      windowMin: 15,
      buyRatio: 0.63,
      uniqueBuyers: 41,
      uniqueSellers: 28,
      top3TraderShare: 0.22,
      proTraderNetUsd: 4100,
      sniperNetUsd: -900,
      devSold: false,
      volumeTrend: 1.4,
      tradeCount: 100
    },
    priceChanges: {
      changePct1m: 0.5,
      changePct5m: 2.1,
      changePct15m: -1.3
    },
    position: { held: true, pnlPct: 34, peakPct: 51 },
    rules: { score: 6, hot: false, gem: true, hideReasons: [] }
  });

  assert.deepEqual(snapshot, {
    symbol: 'AI',
    chain: 'robinhood',
    ageHours: 216,
    market: { mcapUsd: 12740000, liqUsd: 543100, isLaunchpad: false },
    safety: {
      top10: 19,
      dev: 0,
      snipers: 0,
      insiders: 9,
      bundlers: 0,
      holders: 5010,
      proTraders: 61,
      dexPaid: true,
      lpBurned: 100,
      renounced: true,
      taxBuy: 0,
      taxSell: 2
    },
    audit: { danger: false, critical: false, reasons: [] },
    creator: { priorTokens: 3, priorRugs: 1, flagged: false },
    flow: {
      windowMin: 15,
      buyRatio: 0.63,
      uniqueBuyers: 41,
      uniqueSellers: 28,
      top3TraderShare: 0.22,
      proTraderNetUsd: 4100,
      sniperNetUsd: -900,
      devSold: false,
      volumeTrend: 1.4
    },
    price: { changePct1m: 0.5, changePct5m: 2.1, changePct15m: -1.3 },
    position: { held: true, pnlPct: 34, peakPct: 51 },
    rules: { score: 6, hot: false, gem: true, hideReasons: [] }
  });
});

test('privacy allow-list removes wallet, transaction, position, owner, and raw-row data', () => {
  const forbidden = [
    'wallet', 'trader_full', 'tx_hash', 'positionKey', 'owner',
    'trades', 'rawTrades', 'tradeRows'
  ];
  const salted = {
    symbol: 'SAFE',
    wallet: USER_WALLET,
    trader_full: USER_WALLET,
    tx_hash: '0xsynthetic-transaction',
    positionKey: `robinhood|${USER_WALLET}|0xsynthetic-token`,
    owner: USER_WALLET,
    trades: [{ wallet: USER_WALLET, tx_hash: '0xraw-row' }],
    market: {
      mcap: 1000,
      wallet: USER_WALLET,
      rawTrades: [{ trader_full: USER_WALLET }]
    },
    stats: { holders: 10, owner: USER_WALLET },
    intel: { top10: 20, tradeRows: [{ positionKey: 'synthetic-position' }] },
    audit: {
      danger: true,
      reasons: [
        { wallet: USER_WALLET, tx_hash: '0xnested' },
        'contract warning'
      ],
      owner: USER_WALLET
    },
    creator: {
      creatorAddr: DEV_ADDRESS,
      launchCount: 2,
      owner: USER_WALLET
    },
    flow: {
      buyRatio: 0.5,
      trades: [{ trader_full: USER_WALLET, tx_hash: '0xflow-row' }]
    },
    position: { held: true, wallet: USER_WALLET, positionKey: 'synthetic-position' },
    rules: { score: 3, owner: USER_WALLET }
  };

  const snapshot = BBD.features.build(salted);
  const keys = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      visit(child);
    }
  };
  visit(snapshot);

  for (const key of forbidden) assert.equal(keys.includes(key), false, key);
  assert.equal(JSON.stringify(snapshot).includes(USER_WALLET), false);
  assert.deepEqual(snapshot.audit.reasons, ['contract warning']);
});

test('rounding uses whole dollars, one-decimal percentages, and two-decimal ratios', () => {
  const snapshot = BBD.features.build({
    ageHours: 216.26,
    market: { mcap: 12740000.6, liq: 543100.4 },
    intel: {
      top10: 19.46,
      dev: 0.04,
      holders: 5010.6,
      proTraders: 60.6,
      lpBurned: 99.94,
      taxBuy: 0.06,
      taxSell: 2.16
    },
    flow: {
      windowMin: 15.26,
      buyRatio: 0.634,
      uniqueBuyers: 40.6,
      uniqueSellers: 27.6,
      top3TraderShare: 0.226,
      proTraderNetUsd: 4100.6,
      sniperNetUsd: -900.6,
      volumeTrend: 1.446
    },
    priceChanges: {
      changePct1m: 0.54,
      changePct5m: 2.16,
      changePct15m: -1.26
    },
    position: { pnlPct: 33.96, peakPct: 51.04 }
  });

  assert.deepEqual(snapshot, {
    ageHours: 216.3,
    market: { mcapUsd: 12740001, liqUsd: 543100 },
    safety: {
      top10: 19.5,
      dev: 0,
      holders: 5011,
      proTraders: 61,
      lpBurned: 99.9,
      taxBuy: 0.1,
      taxSell: 2.2
    },
    flow: {
      windowMin: 15.3,
      buyRatio: 0.63,
      uniqueBuyers: 41,
      uniqueSellers: 28,
      top3TraderShare: 0.23,
      proTraderNetUsd: 4101,
      sniperNetUsd: -901,
      volumeTrend: 1.45
    },
    price: { changePct1m: 0.5, changePct5m: 2.2, changePct15m: -1.3 },
    position: { pnlPct: 34, peakPct: 51 }
  });
});

test('missing sections are omitted while explicit false audit and held states survive', () => {
  const snapshot = BBD.features.build({
    symbol: null,
    market: null,
    stats: {},
    intel: { top10: null },
    audit: { danger: false, critical: false, reasons: null },
    creator: {},
    flow: [],
    priceChanges: 'bad',
    position: { held: false, pnlPct: null },
    rules: null
  });

  assert.deepEqual(snapshot, {
    audit: { danger: false, critical: false },
    position: { held: false }
  });
  assert.equal(Object.hasOwn(snapshot, 'market'), false);
  assert.equal(Object.hasOwn(snapshot, 'safety'), false);
});

test('creator counts are renamed without exposing its address or inventing a median', () => {
  const snapshot = BBD.features.build({
    creator: {
      creatorAddr: DEV_ADDRESS,
      launchCount: 5,
      ruggedCount: 2,
      flagged: true,
      medianPeakMcap: 80000
    }
  });

  assert.deepEqual(snapshot, {
    creator: { priorTokens: 5, priorRugs: 2, flagged: true }
  });
  assert.equal(Object.hasOwn(snapshot.creator, 'medianPeakMcap'), false);
  assert.equal(JSON.stringify(snapshot).includes(DEV_ADDRESS), false);
});

test('intel wins field-by-field, stats fills gaps, and unknown safety stays absent', () => {
  const snapshot = BBD.features.build({
    stats: {
      top10: 80,
      dev: 4,
      snipers: 3,
      holders: 900,
      pro: 7,
      paid: true
    },
    intel: {
      top10: 12,
      dev: null,
      snipers: Number.NaN,
      dexPaid: false
    }
  });

  assert.deepEqual(snapshot, {
    safety: {
      top10: 12,
      dev: 4,
      snipers: 3,
      holders: 900,
      proTraders: 7,
      dexPaid: false
    }
  });
  assert.equal(Object.hasOwn(snapshot.safety, 'insiders'), false);
  assert.equal(Object.hasOwn(snapshot.safety, 'bundlers'), false);
});

test('reason arrays are bounded, shortened, and never preserve object entries', () => {
  const long = 'x'.repeat(300);
  const snapshot = BBD.features.build({
    audit: {
      reasons: [
        { secret: USER_WALLET },
        long,
        7,
        true,
        'four',
        'five',
        'six',
        'seven',
        'eight',
        'ninth'
      ]
    }
  });

  assert.equal(snapshot.audit.reasons.length, 8);
  assert.equal(snapshot.audit.reasons[0].length, 160);
  assert.deepEqual(snapshot.audit.reasons.slice(1), [
    '7', 'true', 'four', 'five', 'six', 'seven', 'eight'
  ]);
  assert.equal(JSON.stringify(snapshot).includes(USER_WALLET), false);
});

test('garbage inputs and hostile getters never throw and return plain snapshots', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'market', {
    get() {
      throw new Error('hostile getter');
    }
  });
  const garbage = [
    null,
    undefined,
    {},
    [],
    'bad',
    42,
    true,
    hostile,
    {
      symbol: 123,
      chain: {},
      ageHours: Number.POSITIVE_INFINITY,
      market: [],
      stats: 'bad',
      intel: 10,
      audit: { danger: 'false', reasons: {} },
      creator: { launchCount: -1 },
      flow: { buyRatio: Symbol('bad') },
      priceChanges: { changePct1m: Number.NaN },
      position: { held: 0 },
      rules: { score: '6', hideReasons: 'none' }
    }
  ];

  for (const value of garbage) {
    let snapshot;
    assert.doesNotThrow(() => {
      snapshot = BBD.features.build(value);
    });
    assert.equal(snapshot !== null && typeof snapshot === 'object', true);
    assert.equal(Array.isArray(snapshot), false);
    assert.doesNotThrow(() => JSON.stringify(snapshot));
  }
});
