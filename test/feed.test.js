// Feed API taps: the interceptor posts each captured payload and feed.js turns
// it into the caches the guards read. Validates metrics (creator capture),
// list (market), prices, the real CHIPS audit (owner can drain the pool), and
// balances → positionKey. Addresses here are synthetic or public contract
// addresses — no user wallet data.
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

let msgListener = null;
global.location = { origin: 'https://basedbot.app' };
global.window = {
  addEventListener: (type, fn) => { if (type === 'message') msgListener = fn; },
  postMessage: () => {} // replay-request no-op
};
load('src/constants.js'); // BBD.positionKey used by takeBalances
load('src/feed.js');
const F = BBD.feed;
const send = (kind, data) =>
  msgListener({ source: global.window, origin: 'https://basedbot.app', data: { __bbd: 'api', kind, data } });

test('metrics: creatorAddress captured, EVM key lowercased + chain suffix stripped', () => {
  send('metrics', {
    '0xAAA111bbb222ccc333ddd444eee555fff6667778-4663': {
      holdersCount: 300, proTradersCount: 20, top10HoldersPct: 25, devHoldingsPct: 1,
      snipersPct: 2, bundlersPct: 0, insidersPct: 0, dexPaid: true,
      creatorAddress: '0xDEAD00000000000000000000000000000000BEEF'
    }
  });
  assert.equal(F.creatorFor('0xaaa111bbb222ccc333ddd444eee555fff6667778'),
    '0xdead00000000000000000000000000000000beef');
});

test('metrics: a junk creatorAddress is rejected', () => {
  send('metrics', {
    '0xbbb': { holdersCount: 1, proTradersCount: 1, top10HoldersPct: 1, devHoldingsPct: 1,
      snipersPct: 1, bundlersPct: 1, insidersPct: 1, dexPaid: false, creatorAddress: 'not-an-address' }
  });
  assert.equal(F.creatorFor('0xbbb'), null);
});

test('list: market cap / liquidity / launchpad / symbol captured, bad rows skipped', () => {
  send('list', [
    { address: '0xAAA111bbb222ccc333ddd444eee555fff6667778', liquidity_usd: 15000, market_cap_usd: 50000, is_launchpad: true, symbol: 'FOO' },
    { address: 'not-an-address', liquidity_usd: 1, market_cap_usd: 1 },
    { address: '0xCCC', liquidity_usd: null, market_cap_usd: null },
    { address: '0xDDD', liquidity_usd: -5, market_cap_usd: 'x' }
  ]);
  const m = F.marketFor('0xaaa111bbb222ccc333ddd444eee555fff6667778');
  assert.equal(m.liq, 15000);
  assert.equal(m.mcap, 50000);
  assert.equal(m.isLaunchpad, true);
  assert.equal(m.symbol, 'FOO');
  assert.equal(F.marketFor('not-an-address'), null);
  assert.equal(F.marketFor('0xccc'), null);
  assert.equal(F.marketFor('0xddd'), null);
});

test('list: a non-array payload is ignored without throwing', () => {
  assert.doesNotThrow(() => send('list', { not: 'an array' }));
});

test('metrics: a base58 (Solana) creator address keeps its case', () => {
  send('metrics', {
    'So11111111111111111111111111111111111111112': {
      holdersCount: 5, proTradersCount: 2, top10HoldersPct: 5, devHoldingsPct: 0,
      snipersPct: 0, bundlersPct: 0, insidersPct: 0, dexPaid: true,
      creatorAddress: 'DevABCDEFGHJKLMNPQRSTUVWXYZabc123456789'
    }
  });
  assert.equal(F.creatorFor('So11111111111111111111111111111111111111112'),
    'DevABCDEFGHJKLMNPQRSTUVWXYZabc123456789');
});

test('prices: numeric only, negatives and non-numbers rejected', () => {
  send('prices', { ETH: 1930.745, SOL: 77.555, USDC: 1, BAD: 'x', NEG: -5 });
  assert.equal(F.ethPrice(), 1930.745);
  assert.equal(F.priceOf('SOL'), 77.555);
  assert.equal(F.priceOf('BAD'), null);
  assert.equal(F.priceOf('NEG'), null);
});

test('tick: a valid candidate shape is normalised and returned while fresh', (t) => {
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => 1000;
  const addr = '0xABCDEF1111111111111111111111111111111111';
  send('tick', { address: addr, price_usd: 0.00125, market_cap_usd: 42000 });

  assert.deepEqual(F.tickFor(addr), {
    priceUsd: 0.00125,
    mcapUsd: 42000,
    ts: 1000
  });
  assert.deepEqual(F.tickFor(addr.toLowerCase()), F.tickFor(addr));
});

test('tick: a cached value returns null once its short TTL passes', (t) => {
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  const addr = '0x2222222222222222222222222222222222222222';
  Date.now = () => 2000;
  send('tick', { tokenAddress: addr, priceUsd: 3, marketCapUsd: 90000 });
  assert.equal(F.tickFor(addr).priceUsd, 3);

  Date.now = () => 17001;
  assert.equal(F.tickFor(addr), null);
});

test('tick: wrapped and array candidate shapes adapt without shape leakage', () => {
  const addr = 'So11111111111111111111111111111111111111112';
  assert.deepEqual(F.adaptTick([{ data: {
    asset: addr, usd_price: 0.5, market_cap: 1234
  } }]), {
    addr, priceUsd: 0.5, mcapUsd: 1234
  });
  assert.deepEqual(F.adaptTick({ payload: {
    token: addr, price: 0.75, mcap: 1500
  } }), {
    addr, priceUsd: 0.75, mcapUsd: 1500
  });
});

test('tick: missing, non-finite, negative, and unknown prices are rejected', () => {
  const addrs = [
    '0x3000000000000000000000000000000000000000',
    '0x4000000000000000000000000000000000000000',
    '0x5000000000000000000000000000000000000000',
    '0x6000000000000000000000000000000000000000',
    '0x7000000000000000000000000000000000000000',
    '0x8000000000000000000000000000000000000000'
  ];
  send('tick', { address: addrs[0], market_cap_usd: 1 });
  send('tick', { address: addrs[1], price_usd: NaN });
  send('tick', { address: addrs[2], price_usd: -1 });
  send('tick', { address: addrs[3], price_usd: null });
  send('tick', { address: addrs[4], last: 10 });
  send('tick', { address: addrs[5], price_usd: true });
  addrs.forEach((addr) => assert.equal(F.tickFor(addr), null));
});

test('adaptTick returns null for an unrecognised payload shape', () => {
  assert.equal(F.adaptTick({ instrument: 'synthetic', lastUsd: 12.34 }), null);
});

test('notePrice: the newest confirmed trade becomes the tick, order-independent', (t) => {
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => 5000;
  const addr = '0x9999999999999999999999999999999999999999';
  // Deliberately out of order; the latest timestamp must win regardless.
  F.notePrice(addr, [
    { timestamp: '2026-07-24 10:00:00', price_usd: 0.01, is_buy: true },
    { timestamp: '2026-07-24 10:02:00', price_usd: 0.03, is_buy: false },
    { timestamp: '2026-07-24 10:01:00', price_usd: 0.02, is_buy: true }
  ]);
  assert.deepEqual(F.tickFor(addr), { priceUsd: 0.03, mcapUsd: null, ts: 5000 });
});

test('notePrice: preconfirm and unpriced rows never set the tick', () => {
  const addr = '0xaaaa000000000000000000000000000000000000';
  // Newest row is unconfirmed; next-newest has no usable price.
  F.notePrice(addr, [
    { timestamp: '2026-07-24 11:00:03', price_usd: 9, preconfirm: true },
    { timestamp: '2026-07-24 11:00:02', price_usd: 0 },
    { timestamp: '2026-07-24 11:00:01', price_usd: 0.5 }
  ]);
  assert.equal(F.tickFor(addr).priceUsd, 0.5);
});

test('notePrice: garbage input is a no-op, not a throw', () => {
  const addr = '0xbbbb000000000000000000000000000000000000';
  assert.doesNotThrow(() => {
    F.notePrice(addr, null);
    F.notePrice(addr, [{ timestamp: 'nope', price_usd: 1 }]);
    F.notePrice(addr, [{ price_usd: -1 }, null, 'junk']);
    F.notePrice('not-an-address', [{ timestamp: '2026-07-24 11:00:00', price_usd: 1 }]);
  });
  assert.equal(F.tickFor(addr), null);
});

test('audit: the real CHIPS token is flagged danger (owner can drain the pool)', () => {
  const chips = {
    chain: 4663, address: '0xf488d799d8bd6e4c875db014976549d745612847',
    data: { audit: {
      isSafe: false, isTokenSafe: true, isHookSafe: false, ownerRenounced: true,
      hookAudit: { isSafe: false, vulnerabilities: [
        { type: 'LiquidityDrain', impact: 'critical', severity: 90, description: 'Owner can take tokens from the pool and transfer them to an arbitrary address.' },
        { type: 'HiddenFees', impact: 'warning', severity: 55, description: 'Owner can change the fee rate.' }
      ] }
    } }
  };
  send('audit', [chips, { done: true }]);
  const v = F.auditFor('0xf488d799d8bd6e4c875db014976549d745612847');
  assert.equal(v.danger, true);
  assert.equal(v.critical, true);
  assert.equal(v.ownerRenounced, true);
  assert.match(v.reasons[0], /liquidity|trap|drain|pool/i);
  assert.equal(F.auditFor('done'), null); // {done:true} marker produced no entry
});

test('audit: safe token, warnings-only hook = not danger; unsafe contract = danger', () => {
  send('audit', [{ address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    data: { audit: { isTokenSafe: true, isHookSafe: true, ownerRenounced: false, hookAudit: { isSafe: true, vulnerabilities: [] } } } }]);
  assert.equal(F.auditFor('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').danger, false);

  send('audit', [{ address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    data: { audit: { isTokenSafe: true, hookAudit: { isSafe: false, vulnerabilities: [{ type: 'HiddenFees', impact: 'warning', severity: 40 }] } } } }]);
  assert.equal(F.auditFor('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb').danger, false);

  send('audit', [{ address: '0xcccccccccccccccccccccccccccccccccccccccc',
    data: { audit: { isTokenSafe: false, hookAudit: null } } }]);
  assert.equal(F.auditFor('0xcccccccccccccccccccccccccccccccccccccccc').danger, true);
});

test('balances: tokens flatten to positionKey-keyed held positions', () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  const token = '0x2222222222222222222222222222222222222222';
  send('balances', [{ walletAddress: wallet, tokens: [
    { token, symbol: 'TEST', network: 'ROBINHOOD',
      pnl: { relative: -2.12, absolute: -0.004 }, valueUsd: 0.19,
      pool: { chain: 'ROBINHOOD' } },
    { token: 'not-an-addr', symbol: 'X', valueUsd: 1, pnl: { relative: 1 } } // junk skipped
  ] }]);
  assert.equal(F.hasBalances(), true);
  const held = F.heldPositions();
  assert.equal(held.length, 1);
  const p = held[0];
  assert.equal(p.addr, token);
  assert.equal(p.pct, -2.12);
  assert.equal(p.pnlUsd, -0.004);
  assert.equal(p.chain, 'robinhood');
  assert.equal(p.wallet, wallet);
  assert.equal(p.positionKey, BBD.positionKey(token, 'robinhood', wallet));
});

test('pool bridge entries are normalized and returned without a short TTL', (t) => {
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => 5000;
  const addr = '0xABCDEF1111111111111111111111111111111111';
  const pool = '0x5555555555555555555555555555555555555555';

  send('pool', { addr, pool, chain: '4663' });

  assert.deepEqual(F.poolFor(addr.toLowerCase()), { pool, chain: '4663', ts: 5000 });
  Date.now = () => 5000 + (365 * 24 * 60 * 60 * 1000);
  assert.equal(F.poolFor(addr).pool, pool);
  assert.equal(F.poolFor('0x6666666666666666666666666666666666666666'), null);
});

test('malformed or absent pool bridge fields create no entry', () => {
  const missing = '0x7777777777777777777777777777777777777777';
  const malformedPool = '0x8888888888888888888888888888888888888888';
  const malformedChain = '0x9999999999999999999999999999999999999999';
  const missingChain = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  send('pool', { addr: missing, chain: '4663' });
  send('pool', { addr: malformedPool, pool: 'bad pool', chain: '4663' });
  send('pool', {
    addr: missingChain,
    pool: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  });
  send('pool', {
    addr: malformedChain,
    pool: '0xcccccccccccccccccccccccccccccccccccccccc',
    chain: 'bad chain'
  });

  assert.equal(F.poolFor(missing), null);
  assert.equal(F.poolFor(malformedPool), null);
  assert.equal(F.poolFor(missingChain), null);
  assert.equal(F.poolFor(malformedChain), null);
});

test('balances defensively accept a usable candidate pool id', () => {
  const wallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const token = '0xcccccccccccccccccccccccccccccccccccccccc';
  const pool = '0xdddddddddddddddddddddddddddddddddddddddd';

  send('balances', [{ walletAddress: wallet, tokens: [{
    token,
    pool: { chain: 4663, pool_address: pool },
    pnl: { relative: 1, absolute: 1 },
    valueUsd: 2
  }] }]);

  assert.equal(F.poolFor(token).pool, pool);
  assert.equal(F.poolFor(token).chain, '4663');
});

test('cache getters normalize the address the way the writers do', () => {
  const lower = '0xdddddddddddddddddddddddddddddddddddddddd';
  const checksummed = '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

  send('audit', [{ address: lower,
    data: { audit: { isTokenSafe: false, hookAudit: null } } }]);
  // A caller holding the checksummed form must not read this as "not loaded".
  assert.equal(F.auditFor(checksummed).danger, true);
  assert.equal(F.auditFor(lower).danger, true);

  send('list', [{ address: lower, symbol: 'DDD', market_cap_usd: 1000, liquidity_usd: 500 }]);
  assert.equal(F.marketFor(checksummed).liq, 500);

  send('metrics', { [checksummed]: {
    creatorAddress: '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE'
  } });
  // Writers normalize both the key and the creator value.
  assert.equal(F.creatorFor(lower), '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');

  // Base58 addresses are case-sensitive and must survive untouched.
  const solana = 'So11111111111111111111111111111111111111112';
  send('list', [{ address: solana, symbol: 'SOL', market_cap_usd: 7, liquidity_usd: 9 }]);
  assert.equal(F.marketFor(solana).liq, 9);
});

// The tape endpoint sends "YYYY-MM-DD HH:MM:SS" in UTC — not ISO 8601.
const apiTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

test('the tape buffer accumulates across polls and dedupes by tx hash', () => {
  const addr = '0xfeed000000000000000000000000000000000001';
  const trade = (hash, secondsAgo, trader, isBuy) => ({
    tx_hash: hash,
    timestamp: apiTime(Date.now() - secondsAgo * 1000),
    trader_full: trader,
    is_buy: isBuy,
    volume_usd: 50,
    price_usd: 1
  });

  F.noteTrades(addr, [trade('a', 30, '0xaa', true), trade('b', 20, '0xbb', true)]);
  assert.equal(F.tapeFor(addr).length, 2);

  // The next poll overlaps the previous page; only the new row may be added.
  F.noteTrades(addr, [trade('b', 20, '0xbb', true), trade('c', 10, '0xcc', false)]);
  const rows = F.tapeFor(addr);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.txHash), ['a', 'b', 'c']); // oldest first

  // A checksummed caller reads the same buffer.
  assert.equal(F.tapeFor(addr.toUpperCase().replace('0X', '0x')).length, 3);

  // Rows without a hash or a parsable timestamp cannot be deduped or ordered.
  F.noteTrades(addr, [
    { timestamp: apiTime(Date.now()), trader_full: '0xdd', is_buy: true },
    trade('e', 5, '0xee', true)
  ]);
  assert.deepEqual(F.tapeFor(addr).map((r) => r.txHash), ['a', 'b', 'c', 'e']);

  // Unconfirmed rows are excluded, matching notePrice.
  F.noteTrades(addr, [{ ...trade('f', 1, '0xff', true), preconfirm: true }]);
  assert.equal(F.tapeFor(addr).length, 4);

  assert.deepEqual(F.tapeFor('not-an-address'), []);
  assert.deepEqual(F.tapeFor('0xfeed000000000000000000000000000000000009'), []);
});

test('the tape buffer drops rows older than its retention window', () => {
  const addr = '0xfeed000000000000000000000000000000000002';
  const old = {
    tx_hash: 'stale',
    timestamp: apiTime(Date.now() - 3 * 3600 * 1000),
    trader_full: '0xaa', is_buy: true, volume_usd: 10, price_usd: 1
  };
  const fresh = {
    tx_hash: 'fresh',
    timestamp: apiTime(Date.now()),
    trader_full: '0xbb', is_buy: true, volume_usd: 10, price_usd: 1
  };
  F.noteTrades(addr, [old, fresh]);
  assert.deepEqual(F.tapeFor(addr).map((r) => r.txHash), ['fresh']);
});

test('the holder list caches lean rows and reports its age', () => {
  const addr = '0xda7a000000000000000000000000000000000001';
  assert.equal(F.holdersAgeMs(addr), Infinity); // never fetched
  assert.deepEqual(F.holdersFor(addr), []);

  F.noteHolders(addr, [
    { address: '0xtop1', rank: 1, percentage: 1.5, total_pnl_usd: 200,
      funding_source_address_full: '0xAAA', entity_logo: 'https://x/y.png', platform_name: 'noise' },
    { address: '0xtop2', rank: 2, percentage: 0.5, total_pnl_usd: -10 }
  ]);
  const rows = F.holdersFor(addr);
  assert.equal(rows.length, 2);
  // Only the aggregate fields are retained; the logo/platform noise is not.
  assert.deepEqual(Object.keys(rows[0]).sort(),
    ['address', 'funding_source_address', 'funding_source_address_full',
      'percentage', 'rank', 'total_pnl_usd']);
  assert.equal(rows[0].percentage, 1.5);
  assert.equal(rows[0].address, '0xtop1');
  assert.equal(rows[0].funding_source_address_full, '0xAAA');
  assert.ok(F.holdersAgeMs(addr) < 1000);

  // A checksummed caller reads the same entry.
  assert.equal(F.holdersFor(addr.toUpperCase().replace('0X', '0x')).length, 2);
  assert.deepEqual(F.holdersFor('not-an-address'), []);
});
