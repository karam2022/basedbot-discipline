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
load('src/candles.js');

const now = Date.UTC(2026, 6, 23, 15, 20, 0);
const minute = 60 * 1000;
const EVM_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EVM_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const EVM_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const SOL_A = 'AbCdEfGhijkLMNPqrstUVwxyz123456789';
const SOL_B = 'ZyXwVuTsrqPnmLKJihGfedcba987654321';

const trade = (timestamp, overrides = {}) => ({
  timestamp,
  trader: '0xaaaa...aaaa',
  trader_full: EVM_A,
  amount_token: 2.6567000480193133,
  amount_quote: 0.000162092204274529,
  is_buy: true,
  is_pro_trader: false,
  is_sniper: false,
  price: 0.0000614427049835303,
  price_usd: 10,
  volume_native: 0.000017849607360248047,
  volume_usd: 1,
  tx_hash: `0xtx${timestamp}`,
  tx_count: 4,
  block: 17387242,
  log_index: 1,
  preconfirm: false,
  ...overrides
});

test('shared trade timestamp parser treats the API format as strict UTC', () => {
  assert.equal(
    BBD.parseTradeTimestamp('2026-07-23 15:15:09'),
    Date.UTC(2026, 6, 23, 15, 15, 9)
  );
  assert.equal(BBD.parseTradeTimestamp('2026-02-31 15:15:09'), null);
  assert.equal(BBD.parseTradeTimestamp('2026-07-23T15:15:09Z'), null);
});

test('build buckets boundaries with correct OHLCV and oldest-first ordering', () => {
  const candles = BBD.candles.build([
    trade('2026-07-23 15:16:00', {
      price_usd: 11, volume_usd: 5, is_buy: false, log_index: 4
    }),
    trade('2026-07-23 15:15:59', {
      price_usd: 9, volume_usd: 4, log_index: 3
    }),
    trade('2026-07-23 15:15:00', {
      price_usd: 10, volume_usd: 2, log_index: 1
    }),
    trade('2026-07-23 15:15:20', {
      price_usd: 12, volume_usd: 3, is_buy: false, log_index: 2
    })
  ], { bucketMs: minute, now });

  assert.deepEqual(candles, [
    {
      t: Date.UTC(2026, 6, 23, 15, 15),
      o: 10, h: 12, l: 9, c: 9, v: 9, buys: 2, sells: 1
    },
    {
      t: Date.UTC(2026, 6, 23, 15, 16),
      o: 11, h: 11, l: 11, c: 11, v: 5, buys: 0, sells: 1
    }
  ]);
});

test('unsorted tape produces the same candles as sorted tape', () => {
  const sorted = [
    trade('2026-07-23 15:14:00', { price_usd: 8, log_index: 1 }),
    trade('2026-07-23 15:15:00', { price_usd: 9, log_index: 2 }),
    trade('2026-07-23 15:15:30', { price_usd: 11, log_index: 3 })
  ];
  assert.deepEqual(
    BBD.candles.build([...sorted].reverse(), { bucketMs: minute, now }),
    BBD.candles.build(sorted, { bucketMs: minute, now })
  );
});

test('build omits empty buckets and excludes explicit preconfirmations', () => {
  const candles = BBD.candles.build([
    trade('2026-07-23 15:15:00', { price_usd: 10 }),
    trade('2026-07-23 15:16:00', { price_usd: 999, preconfirm: true }),
    trade('2026-07-23 15:17:00', { price_usd: 12 })
  ], { bucketMs: minute, now });

  assert.deepEqual(candles.map((c) => [c.t, c.c]), [
    [Date.UTC(2026, 6, 23, 15, 15), 10],
    [Date.UTC(2026, 6, 23, 15, 17), 12]
  ]);
});

test('flow returns null ratios rather than dividing by zero', () => {
  const result = BBD.candles.flow([
    trade('2026-07-23 15:19:00', { volume_usd: 0 }),
    trade('2026-07-23 15:19:30', { volume_usd: -20, is_buy: false })
  ], { windowMs: 5 * minute, now });

  assert.equal(result.buyRatio, null);
  assert.equal(result.top3TraderShare, null);
  assert.equal(result.volumeTrend, null);
  assert.equal(result.tradeCount, 2);
});

test('top-three share includes every known trader when fewer than three exist', () => {
  const result = BBD.candles.flow([
    trade('2026-07-23 15:19:00', {
      trader_full: EVM_A, volume_usd: 10
    }),
    trade('2026-07-23 15:19:30', {
      trader_full: EVM_B, volume_usd: 30, is_buy: false
    })
  ], { windowMs: 5 * minute, now });

  assert.equal(result.top3TraderShare, 1);
});

test('devSold compares EVM case-insensitively and base58 case-sensitively', () => {
  const evm = BBD.candles.flow([
    trade('2026-07-23 15:19:00', {
      trader_full: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      is_buy: false
    })
  ], { windowMs: 5 * minute, now, creatorAddr: EVM_A });
  assert.equal(evm.devSold, true);

  const differentCase = BBD.candles.flow([
    trade('2026-07-23 15:19:00', {
      trader_full: SOL_A.toLowerCase(),
      is_buy: false
    })
  ], { windowMs: 5 * minute, now, creatorAddr: SOL_A });
  assert.equal(differentCase.devSold, false);

  const exactCase = BBD.candles.flow([
    trade('2026-07-23 15:19:00', {
      trader_full: SOL_A,
      is_buy: false
    })
  ], { windowMs: 5 * minute, now, creatorAddr: SOL_A });
  assert.equal(exactCase.devSold, true);
});

test('pro-trader and sniper nets preserve net-selling as negative', () => {
  const result = BBD.candles.flow([
    trade('2026-07-23 15:16:00', {
      volume_usd: 10, is_pro_trader: true
    }),
    trade('2026-07-23 15:17:00', {
      volume_usd: 25, is_buy: false, is_pro_trader: true
    }),
    trade('2026-07-23 15:18:00', {
      volume_usd: 2, is_sniper: true
    }),
    trade('2026-07-23 15:19:00', {
      volume_usd: 7, is_buy: false, is_sniper: true
    })
  ], { windowMs: 5 * minute, now });

  assert.equal(result.proTraderNetUsd, -15);
  assert.equal(result.sniperNetUsd, -5);
});

test('garbage tape and options return well-formed empty or neutral results', () => {
  const emptyFlow = {
    buyRatio: null,
    uniqueBuyers: 0,
    uniqueSellers: 0,
    top3TraderShare: null,
    proTraderNetUsd: 0,
    sniperNetUsd: 0,
    devSold: false,
    volumeTrend: null,
    tradeCount: 0
  };
  const hostile = {};
  Object.defineProperty(hostile, 'preconfirm', {
    get() {
      throw new Error('hostile getter');
    }
  });
  const garbage = [
    null,
    undefined,
    {},
    hostile,
    trade('not-a-date'),
    trade('2026-07-23 15:21:00'),
    trade('2026-07-23 15:19:00', { price_usd: -1 }),
    trade('2026-07-23 15:19:00', { price_usd: Number.NaN }),
    trade('2026-07-23 15:19:00', { price_usd: Symbol('bad') }),
    trade('2026-07-23 15:19:00', { is_buy: 'yes' }),
    trade('2026-07-23 15:19:00', { preconfirm: true })
  ];

  assert.deepEqual(BBD.candles.build(null, { bucketMs: minute, now }), []);
  assert.deepEqual(BBD.candles.build(undefined, { bucketMs: minute, now }), []);
  assert.deepEqual(BBD.candles.build('not-an-array', { bucketMs: minute, now }), []);
  assert.deepEqual(BBD.candles.build(garbage, { bucketMs: minute, now }), []);
  assert.deepEqual(BBD.candles.build([], { bucketMs: -1, now }), []);
  assert.deepEqual(BBD.candles.build([], { bucketMs: minute, now: Number.NaN }), []);
  assert.deepEqual(BBD.candles.build([], null), []);

  const flowGarbage = [
    null,
    undefined,
    {},
    hostile,
    trade('not-a-date'),
    trade('2026-07-23 15:21:00'),
    trade('2026-07-23 15:19:00', { is_buy: 'yes' }),
    trade('2026-07-23 15:19:00', { preconfirm: true })
  ];
  assert.deepEqual(BBD.candles.flow(null, { windowMs: minute, now }), emptyFlow);
  assert.deepEqual(BBD.candles.flow(undefined, { windowMs: minute, now }), emptyFlow);
  assert.deepEqual(BBD.candles.flow({}, { windowMs: minute, now }), emptyFlow);
  assert.deepEqual(BBD.candles.flow(flowGarbage, { windowMs: minute, now }), emptyFlow);
  assert.deepEqual(BBD.candles.flow([], { windowMs: -1, now }), emptyFlow);
  assert.deepEqual(BBD.candles.flow([], null), emptyFlow);

  const negativeVolume = trade('2026-07-23 15:19:00', { volume_usd: -10 });
  assert.equal(
    BBD.candles.build([negativeVolume], { bucketMs: minute, now })[0].v,
    0
  );
  assert.equal(
    BBD.candles.flow([negativeVolume], { windowMs: minute, now }).tradeCount,
    1
  );
  assert.equal(
    BBD.candles.build([
      trade('2026-07-23 15:19:00', { volume_usd: Number.NaN })
    ], { bucketMs: minute, now })[0].v,
    0
  );
  assert.deepEqual(BBD.candles.priceChanges(null, { now }), {
    changePct1m: null, changePct5m: null, changePct15m: null
  });
  assert.deepEqual(BBD.candles.priceChanges([{}, hostile], { now }), {
    changePct1m: null, changePct5m: null, changePct15m: null
  });
});

test('realistic multi-trade tape computes concentration and directional flow together', () => {
  const trades = [
    trade('2026-07-23 15:19:00', {
      trader_full: EVM_A, volume_usd: 100, is_buy: false, is_pro_trader: true
    }),
    trade('2026-07-23 15:18:00', {
      trader_full: EVM_B, volume_usd: 300, is_pro_trader: true
    }),
    trade('2026-07-23 15:16:00', {
      trader_full: EVM_C, volume_usd: 200, is_sniper: true
    }),
    trade('2026-07-23 15:14:00', {
      trader_full: EVM_A, volume_usd: 100, is_pro_trader: true
    }),
    trade('2026-07-23 15:12:00', {
      trader_full: SOL_B, volume_usd: 100, is_buy: false, is_sniper: true
    }),
    trade('2026-07-23 15:18:30', {
      trader_full: SOL_A, volume_usd: 1000, preconfirm: true
    }),
    trade('2026-07-23 15:09:59', {
      trader_full: SOL_A, volume_usd: 1000
    }),
    trade('2026-07-23 15:20:01', {
      trader_full: SOL_A, volume_usd: 1000
    })
  ];

  const result = BBD.candles.flow(trades, {
    windowMs: 10 * minute,
    now,
    creatorAddr: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  });

  assert.equal(result.buyRatio, 0.75);
  assert.equal(result.uniqueBuyers, 3);
  assert.equal(result.uniqueSellers, 2);
  assert.equal(result.top3TraderShare, 0.875);
  assert.equal(result.proTraderNetUsd, 300);
  assert.equal(result.sniperNetUsd, 100);
  assert.equal(result.devSold, true);
  assert.equal(result.volumeTrend, 3);
  assert.equal(result.tradeCount, 5);
});

test('priceChanges exposes 1/5/15-minute changes from candle closes', () => {
  const candles = BBD.candles.build([
    trade('2026-07-23 15:04:00', { price_usd: 80 }),
    trade('2026-07-23 15:14:00', { price_usd: 100 }),
    trade('2026-07-23 15:18:00', { price_usd: 110 }),
    trade('2026-07-23 15:19:00', { price_usd: 120 }),
    trade('2026-07-23 15:21:00', { price_usd: 999 })
  ], { bucketMs: minute, now });
  const changes = BBD.candles.priceChanges(candles, { now });

  assert.ok(Math.abs(changes.changePct1m - 9.090909090909092) < 1e-12);
  assert.equal(changes.changePct5m, 20);
  assert.equal(changes.changePct15m, 50);
});
