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
