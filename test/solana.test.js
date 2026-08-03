// Solana runs on a different backend than the EVM chains: api/2/token/security
// replaces both metrics/batch and audit/batch, and api/v1/monitor is the only
// place a Solana token page exposes its pool id. Payload shapes captured live
// 2026-08-01 — see docs/solana-support.md §2/§3.
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
  postMessage: () => {}
};
load('src/constants.js');
load('src/chain.js');
load('src/score.js');
load('src/candles.js');
load('src/feed.js');
const F = BBD.feed;
const send = (kind, data) =>
  msgListener({ source: global.window, origin: 'https://basedbot.app', data: { __bbd: 'api', kind, data } });

const ADDR = '63hENiP16MC6qrwD5QdUAfeaAnYm7ovxJu89JVxDpump';
const POOL = 'WGTogYpHuiBHctPEX5zfwLtSx2sUkxSp4T2ePEKDu8c';

// The exact shape observed on api/2/token/security, trimmed to the fields read.
const security = (over) => ({
  address: ADDR,
  chainId: 'solana:solana',
  top10HoldingsPercentage: 14.653415393986696,
  burnedHoldingsPercentage: null,
  buyFeePercentage: 0,
  sellFeePercentage: 0,
  transferFeePercentage: 0,
  isMintable: false,
  isFreezable: false,
  transferPausable: false,
  isBlacklisted: false,
  isHoneypot: null,
  isLaunchpadToken: true,
  ...over
});

test('a clean Solana token produces no audit danger', () => {
  send('security', security());
  const a = F.auditFor(ADDR);
  assert.equal(a.danger, false);
  assert.equal(a.critical, false);
  // Both authorities revoked is the Solana equivalent of a renounced owner.
  assert.equal(a.ownerRenounced, true);
});

test('an active freeze authority is critical — it blocks the exit', () => {
  send('security', security({ address: 'Freeze1111111111111111111111111111111111111', isFreezable: true }));
  const a = F.auditFor('Freeze1111111111111111111111111111111111111');
  assert.equal(a.danger, true);
  assert.equal(a.critical, true);
  assert.match(a.reasons[0], /freeze authority/i);
});

test('an active mint authority is dangerous but not exit-blocking', () => {
  const addr = 'Mint11111111111111111111111111111111111111';
  send('security', security({ address: addr, isMintable: true }));
  const a = F.auditFor(addr);
  assert.equal(a.danger, true);
  assert.equal(a.critical, false); // supply dilution, but you can still sell
  assert.equal(a.ownerRenounced, false);
  assert.match(a.reasons[0], /mint authority/i);
});

test('honeypot, blacklist and pausable transfers each count as critical', () => {
  // Base58 has no 0/O/I/l — these stand-ins deliberately avoid them.
  const cases = [
    ['Honey11111111111111111111111111111111111111', { isHoneypot: true }],
    ['Banned1111111111111111111111111111111111111', { isBlacklisted: true }],
    ['Pause11111111111111111111111111111111111111', { transferPausable: true }]
  ];
  for (const [addr, over] of cases) {
    send('security', security({ address: addr, ...over }));
    assert.equal(F.auditFor(addr).critical, true, `expected critical for ${JSON.stringify(over)}`);
  }
});

test('the security block carries the tax the token page never shows', () => {
  const addr = 'Tax111111111111111111111111111111111111111';
  send('security', security({ address: addr, buyFeePercentage: 5, sellFeePercentage: 25 }));
  const s = F.securityFor(addr);
  assert.equal(s.buyTax, 5);
  assert.equal(s.sellTax, 25);
  assert.equal(s.top10, 14.653415393986696);
  assert.equal(s.isLaunchpad, true);
});

test('a batched security response is accepted too', () => {
  const a = 'Batch11111111111111111111111111111111111111';
  const b = 'Batch22222222222222222222222222222222222222';
  send('security', [security({ address: a }), security({ address: b, isFreezable: true })]);
  assert.equal(F.auditFor(a).critical, false);
  assert.equal(F.auditFor(b).critical, true);
});

test('garbage in the security payload creates no entry', () => {
  send('security', { address: 'not-an-address', isFreezable: true });
  send('security', [null, 42, { isFreezable: true }]);
  assert.equal(F.auditFor('not-an-address'), null);
});

test('monitor supplies the pool the Solana page never requests', () => {
  send('monitor', {
    chain: -1,
    tokenInfo: { token: { address: ADDR }, chainId: -1 },
    poolInfo: { token: { address: ADDR }, chainId: -1, address: POOL }
  });
  const p = F.poolFor(ADDR);
  assert.equal(p.pool, POOL);
  // -1 must land as the canonical key, so the tape fetch and the position
  // lookup agree on what chain this is.
  assert.equal(p.chain, 'solana');
});

test('a monitor payload without a pool changes nothing', () => {
  const addr = 'NoPool1111111111111111111111111111111111111';
  send('monitor', { chain: -1, tokenInfo: { token: { address: addr } } });
  assert.equal(F.poolFor(addr), null);
});

test('unknown card stats never earn a safety bonus', () => {
  // Solana cards render "?%" until stats resolve; parseCardStats maps those to
  // null. null <= n is true, so without the guard an unmeasured card would
  // collect the full bonus for values nobody has seen.
  const unknown = {
    holders: 500, pro: 50, paid: true,
    top10: null, dev: null, snipers: null, bundlers: null, insiders: null
  };
  // Only the two facts actually known (paid, holders >= 300) may score.
  assert.equal(BBD.statBonus(unknown), 2);

  const known = { ...unknown, top10: 10, dev: 0, snipers: 0, bundlers: 0, insiders: 0 };
  assert.equal(BBD.statBonus(known), 6);
});

// --- the tape -------------------------------------------------------------
// Shape captured live from api/2/token/trades: epoch-ms `date`, a "buy"/"sell"
// `type`, camelCase USD amounts and a `labels` array where the EVM tape has
// is_pro_trader / is_sniper booleans (docs/solana-support.md §2).
const TAPE_TOKEN = '4Nm6DVLM9NpaxFDLs8LkfzFon3igUZzfi5wdFm5mpump';
const TRADER = 'TraderTestAddress111111111111111111111111111';

// Timestamps must be relative to now: tapeFor() drops rows outside a one-hour
// retention window, so fixtures pinned to the moment of capture would pass on
// the day they were written and fail every day after.
const NOW = Date.now();

const svmTrade = (over) => ({
  id: '33802149555',
  operation: 'regular',
  type: 'sell',
  baseTokenAmount: 85503.8958,
  baseTokenAmountUSD: 0.18750862275324565,
  quoteTokenAmountUSD: 0.18750862275324565,
  date: NOW - 60 * 1000,
  swapSenderAddress: TRADER,
  transactionSenderAddress: TRADER,
  blockchain: 'Solana',
  transactionHash: '3t9sSxrnjQzCzWpfN4oiLUt6oEkEnJJyaJzxTzK3ksZJkHajisX59tNrHNqPhWXHGjgy',
  marketAddress: '7MJJqCb2bdTkuFa8m1pgymAJFbck2sUnyQREmyS9Ve7C',
  baseTokenPriceUSD: 0.0000021929833839599814,
  baseTokenMarketCapUSD: 2192.9833839599814,
  labels: ['proTrader'],
  baseToken: { address: TAPE_TOKEN, symbol: 'OLLIE', decimals: 6 },
  quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
  ...over
});

test('the Solana tape normalizes into the same rows the EVM tape produces', () => {
  send('svmtrades', [
    svmTrade(),
    svmTrade({ transactionHash: 'hash2', type: 'buy', date: NOW - 64 * 1000 })
  ]);
  const rows = F.tapeFor(TAPE_TOKEN);
  assert.equal(rows.length, 2);
  // Oldest first, exactly like the EVM tape.
  assert.equal(rows[0].isBuy, true);
  assert.equal(rows[1].isBuy, false);
  assert.equal(rows[1].trader, TRADER);
  assert.equal(rows[1].volumeUsd, 0.18750862275324565);
  // labels:["proTrader"] is where the EVM tape has is_pro_trader.
  assert.equal(rows[1].isPro, true);
  assert.equal(rows[1].isSniper, false);
});

test('rows are attributed by baseToken.address, not by the request', () => {
  // One response may legitimately cover more than one token, and the POST body
  // is not visible to the tap — the row has to name its own token.
  const other = 'Gfq4c5SDPBKkBQ3Xzm3KLiYWe2cuYE8Gxv8upEyCpump';
  send('svmtrades', [
    svmTrade({ transactionHash: 'ha', baseToken: { address: other } }),
    svmTrade({ transactionHash: 'hb' })
  ]);
  assert.equal(F.tapeFor(other).length, 1);
  send('svmtrades', [svmTrade({ transactionHash: 'hc', baseToken: null })]);
  send('svmtrades', [svmTrade({ transactionHash: 'hd', baseToken: { address: 'nope' } })]);
  assert.equal(F.tapeFor('nope').length, 0);
});

test('the tape doubles as the price feed Solana otherwise lacks', () => {
  const addr = 'Price11111111111111111111111111111111111111';
  send('svmtrades', [
    svmTrade({ transactionHash: 'p1', date: NOW - 600 * 1000, baseTokenPriceUSD: 1, baseToken: { address: addr } }),
    svmTrade({ transactionHash: 'p2', date: NOW - 5 * 1000, baseTokenPriceUSD: 2, baseTokenMarketCapUSD: 4242, baseToken: { address: addr } })
  ]);
  const tick = F.tickFor(addr);
  assert.equal(tick.priceUsd, 2); // newest row wins, not last-in-array
  assert.equal(tick.mcapUsd, 4242);
});

test('an unrecognized operation is dropped, never read as a sell', () => {
  const addr = 'Weird11111111111111111111111111111111111111';
  send('svmtrades', [
    svmTrade({ transactionHash: 'w1', type: 'liquidityAdd', baseToken: { address: addr } }),
    svmTrade({ transactionHash: 'w2', type: '', baseToken: { address: addr } }),
    svmTrade({ transactionHash: 'w3', date: 0, baseToken: { address: addr } })
  ]);
  assert.equal(F.tapeFor(addr).length, 0);
});

test('candles read the Solana rows without a translation layer', () => {
  const now = NOW;
  const rows = [
    svmTrade({ transactionHash: 'c1', type: 'buy', date: now - 90000, baseTokenPriceUSD: 1, baseTokenAmountUSD: 10 }),
    svmTrade({ transactionHash: 'c2', type: 'sell', date: now - 30000, baseTokenPriceUSD: 2, baseTokenAmountUSD: 30 })
  ];
  const candles = BBD.candles.build(rows, { bucketMs: 60000, now });
  assert.equal(candles.length, 2);
  assert.equal(candles[0].o, 1);
  assert.equal(candles[1].c, 2);

  const flow = BBD.candles.flow(rows, { windowMs: 5 * 60000, now, creatorAddr: TRADER });
  assert.equal(flow.tradeCount, 2);
  // The creator is the sender on both rows, and one of them is a sell.
  assert.equal(flow.devSold, true);
  // labels:["proTrader"] must reach the flow as pro-trader volume.
  assert.equal(flow.proTraderNetUsd, -20);
});

test('the raw Solana rows stay available for the readouts, bounded', () => {
  const addr = 'Rawww11111111111111111111111111111111111111';
  const batch = Array.from({ length: 600 }, (_, i) => svmTrade({
    transactionHash: 'r' + i, date: NOW - 600000 + i, baseToken: { address: addr }
  }));
  send('svmtrades', batch);
  const raw = F.svmTradesFor(addr);
  assert.equal(raw.length, 500); // SVM_RAW_MAX
  assert.equal(raw[raw.length - 1].transactionHash, 'r599'); // newest retained
  // Overlapping pages must not duplicate rows.
  send('svmtrades', [svmTrade({ transactionHash: 'r599', baseToken: { address: addr } })]);
  assert.equal(F.svmTradesFor(addr).filter((r) => r.transactionHash === 'r599').length, 1);
});

// --- pulse feed + creator history -----------------------------------------
// api/2/pulse is the counterpart to BOTH /api/tokens and metrics/batch: three
// buckets of 100, every card stat, the pool, the socials and the deployer in
// one payload. Percentages arrive already scaled 0-100.
const pulseToken = (over) => ({
  address: 'DoWUepujSH3UYeqNG8tCSNTFuRDSX9cQnw2mwuSGpump',
  chainId: 'solana:solana',
  symbol: 'Blue',
  name: 'The Quest Giver',
  deployer: 'bwamJzztZsepfkteWRChggmXuiiCQvpLqPietdNfSXa',
  poolAddress: '9rXwaZ8ypKUaAZY3F1jrwDpevMwDEKwY7czmfRYLeHgs',
  holdersCount: 321,
  proTradersCount: 71,
  top10Holdings: 6.674102210357099,
  devHoldings: 0,
  snipersHoldings: 0,
  bundlersHoldings: 0,
  insidersHoldings: 0,
  dexscreenerAdPaid: true,
  liquidity: 7445.447524707039,
  marketCap: 2280.501115739584,
  bondingPercentage: 8.349993373571808,
  socials: { twitter: null, website: null, telegram: null, others: {} },
  ...over
});
const pulse = (rows) => ({ new: { data: rows }, bonding: { data: [] }, bonded: { data: [] } });

test('the pulse payload fills stats, market, pool and creator at once', () => {
  const t = pulseToken();
  send('pulse', pulse([t]));
  const s = F.statsFor(t.address);
  assert.equal(s.holders, 321);
  assert.equal(s.pro, 71);
  assert.equal(s.top10, 6.674102210357099);
  assert.equal(s.paid, true);
  const m = F.marketFor(t.address);
  assert.equal(m.liq, 7445.447524707039);
  assert.equal(m.mcap, 2280.501115739584);
  assert.equal(m.isLaunchpad, true);
  assert.equal(F.creatorFor(t.address), t.deployer);
  assert.equal(F.poolFor(t.address).pool, t.poolAddress);
  assert.equal(F.poolFor(t.address).chain, 'solana');
});

test('an incomplete stat block is left to the DOM parser', () => {
  // Same bar as takeMetrics: partial stats must not gate safety checks.
  const addr = 'Partia1111111111111111111111111111111111111';
  send('pulse', pulse([pulseToken({ address: addr, top10Holdings: null })]));
  assert.equal(F.statsFor(addr), null);
  // ...but the market and the deployer are still worth keeping.
  assert.equal(F.marketFor(addr).mcap, 2280.501115739584);
  assert.ok(F.creatorFor(addr));
});

test('all three buckets are read, not just the first', () => {
  const a = 'Bucket11111111111111111111111111111111111111';
  const b = 'Bucket22222222222222222222222222222222222222';
  send('pulse', {
    new: { data: [] },
    bonding: { data: [pulseToken({ address: a })] },
    bonded: { data: [pulseToken({ address: b })] }
  });
  assert.ok(F.statsFor(a));
  assert.ok(F.statsFor(b));
});

test('a launchpad "website" that is really a social link is not utility', () => {
  // The dev types this field at launch; on pump.fun it is routinely an
  // Instagram reel. Counting it as Website would grant the never-auto-hide
  // pass UTILITY_TITLES gives and gut the meme filter.
  const addr = 'Socia111111111111111111111111111111111111111';
  send('pulse', pulse([pulseToken({
    address: addr,
    socials: {
      website: 'https://www.instagram.com/reel/DbYgv46OQlC/',
      twitter: 'https://x.com/Den_O1_/status/2083670561021215200',
      telegram: null,
      others: { createdOn: 'https://pump.fun' }
    }
  })]));
  const titles = F.titlesFor(addr);
  assert.equal(titles.includes('Website'), false);
  assert.equal(titles.includes('Instagram'), true);
  assert.equal(titles.includes('X'), true);
  // The launchpad itself is never a project website.
  assert.equal(titles.length, 2);
});

test('a real domain still counts as a website', () => {
  const addr = 'Website111111111111111111111111111111111111';
  send('pulse', pulse([pulseToken({
    address: addr,
    socials: { website: 'https://myproject.xyz/docs', twitter: null, telegram: null, others: {} }
  })]));
  assert.deepEqual(F.titlesFor(addr), ['Website']);
});

test('the deployer report is attributed via the open token page', () => {
  const token = 'Deptok1111111111111111111111111111111111111';
  const dev = 'Devwa11111111111111111111111111111111111111';
  send('pulse', pulse([pulseToken({ address: token, deployer: dev })]));
  global.location.pathname = `/token/sol/${token}`;

  send('deployer', {
    pagination: { total: 89 },
    data: [
      { token: { address: token, symbol: 'GRAM', marketCapUSD: 2000, approximateReserveUSD: 1500 } },
      { token: { address: 'Rugged1111111111111111111111111111111111111', symbol: 'DEAD', marketCapUSD: 40, approximateReserveUSD: 30 } }
    ]
  });
  const report = F.deployerFor(dev);
  assert.equal(report.total, 89);
  assert.equal(report.tokens.length, 2);
  assert.equal(report.tokens[1].liq, 30);
});

test('a deployer payload with no open token page is dropped', () => {
  global.location.pathname = '/portfolio';
  send('deployer', { pagination: { total: 5 }, data: [] });
  assert.equal(F.deployerFor('Nobody111111111111111111111111111111111111'), null);
});
