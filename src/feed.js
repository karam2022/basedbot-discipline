// In-memory cache of the API payloads tapped by interceptor.js (MAIN world).
// Everything arriving via postMessage is untrusted input and re-validated
// here; DOM parsing stays as fallback for anything the cache misses. Shapes
// mirror parseCardStats so consumers can't tell the sources apart.
'use strict';

BBD.feed = (() => {
  // Stats gate 🔥 alerts — stale values must lose to a fresh DOM parse.
  const STATS_TTL_MS = 10 * 60 * 1000;
  const TICK_TTL_MS = 15 * 1000;
  const MAX_ENTRIES = 1500;
  const stats = new Map();   // addr -> { holders, pro, top10, ..., paid, ts }
  const titles = new Map();  // addr -> { list: ['Website', ...], ts }
  const creator = new Map(); // addr -> creatorAddress (for the creator guard)
  const market = new Map();  // addr -> { liq, mcap, isLaunchpad, symbol, ts }
  const ticks = new Map();   // addr -> { priceUsd, mcapUsd, ts }
  const audit = new Map();   // addr -> { danger, critical, ownerRenounced, reasons, ts }
  const balances = new Map(); // positionKey -> validated held-position snapshot
  const pools = new Map();   // addr -> { pool, chain, ts }
  let balancesSeen = false;
  let balancesTs = 0;
  let prices = {};           // { ETH: number, SOL: number, ... }

  // metadata/batch keys carry a chain suffix ("0x…-4663"); metrics keys don't.
  // Mirror tokenAddrFromHref (#5): lowercase hex EVM addresses for stable keys,
  // but leave case-sensitive base58 Solana addresses untouched — lowercasing
  // them means the cache key never matches the DOM-derived address.
  const normAddr = (key) => {
    const base = String(key).replace(/-\d+$/, '');
    return base.startsWith('0x') ? base.toLowerCase() : base;
  };

  const pct = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  };
  const count = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const usd = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  // creatorAddress / token address share the EVM-lowercase, base58-preserve rule.
  const isAddr = (v) => typeof v === 'string' && /^(0x[a-fA-F0-9]{6,}|[1-9A-HJ-NP-Za-km-z]{20,})$/.test(v);
  const poolId = (v) =>
    typeof v === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(v) ? v : null;
  const chainId = (v) => {
    if (typeof v !== 'string' && !Number.isSafeInteger(v)) return null;
    const chain = String(v).toLowerCase();
    return /^[a-z0-9_-]{1,64}$/.test(chain) ? chain : null;
  };

  // Dormant JSON tick adapter. The real swap socket turned out to be binary
  // MessagePack with positional (unnamed) fields, running inside a Web Worker
  // the MAIN-world tap can't reach — so notePrice() (REST) is the live source.
  // Kept as a named-field decoder in case basedbot ever exposes a JSON socket;
  // an unknown shape must miss cleanly rather than guess.
  const adaptTick = (raw) => {
    const addressFields = ['address', 'token_address', 'tokenAddress', 'asset', 'token']; // unverified
    const priceFields = ['price_usd', 'priceUsd', 'price', 'usd_price']; // unverified
    const mcapFields = ['market_cap_usd', 'marketCapUsd', 'mcap', 'market_cap']; // unverified
    const queue = Array.isArray(raw) ? [...raw] : [raw];
    const seen = new Set();
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (!item || typeof item !== 'object' || seen.has(item)) continue;
      seen.add(item);
      if (Array.isArray(item)) {
        queue.push(...item);
        continue;
      }
      if (item.data && typeof item.data === 'object') queue.push(item.data);
      if (item.payload && typeof item.payload === 'object') queue.push(item.payload);
      const pick = (fields) => {
        const key = fields.find((field) => Object.prototype.hasOwnProperty.call(item, field));
        return key === undefined ? undefined : item[key];
      };
      const numberish = (v) =>
        typeof v === 'number' || (typeof v === 'string' && v.trim() !== '');
      const addr = pick(addressFields);
      const priceRaw = pick(priceFields);
      if (!isAddr(addr) || !numberish(priceRaw)) continue;
      const priceUsd = usd(priceRaw);
      if (priceUsd === null) continue;
      const mcapRaw = pick(mcapFields);
      if (mcapRaw !== undefined && !numberish(mcapRaw)) continue;
      const mcapUsd = mcapRaw === undefined ? null : usd(mcapRaw);
      if (mcapRaw !== undefined && mcapUsd === null) continue;
      return { addr, priceUsd, mcapUsd };
    }
    return null;
  };

  const prune = (map) => {
    if (map.size <= MAX_ENTRIES) return;
    [...map.entries()]
      .sort((a, b) => a[1].ts - b[1].ts)
      .slice(0, map.size - MAX_ENTRIES)
      .forEach(([k]) => map.delete(k));
  };

  const takeMetrics = (data) => {
    for (const [key, m] of Object.entries(data)) {
      if (!m || typeof m !== 'object') continue;
      const entry = {
        holders: count(m.holdersCount),
        pro: count(m.proTradersCount),
        top10: pct(m.top10HoldersPct),
        dev: pct(m.devHoldingsPct),
        snipers: pct(m.snipersPct),
        bundlers: pct(m.bundlersPct),
        insiders: pct(m.insidersPct),
        paid: m.dexPaid === true,
        ts: Date.now()
      };
      const addr = normAddr(key);
      // creatorAddress rides on the metrics payload; cache it regardless of
      // whether the stat block itself is complete (the creator guard wants it).
      if (isAddr(m.creatorAddress)) creator.set(addr, normAddr(m.creatorAddress));
      // Same completeness bar as parseCardStats: partial stats can't be
      // trusted to gate safety checks — skip and let the DOM parser try.
      if (entry.holders === null || entry.pro === null) continue;
      if ([entry.top10, entry.dev, entry.snipers, entry.bundlers, entry.insiders]
        .some((v) => v === null)) continue;
      stats.set(addr, entry);
    }
    prune(stats);
    prune(creator);
  };

  // Feed list payload (/api/tokens): market cap + liquidity per token, the
  // observed values the creator guard uses to detect a rug (peaked then died).
  const takeList = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const t of rows) {
      if (!t || typeof t !== 'object' || !isAddr(t.address)) continue;
      const liq = usd(t.liquidity_usd);
      const mcap = usd(t.market_cap_usd);
      if (liq === null && mcap === null) continue;
      market.set(normAddr(t.address), {
        liq, mcap,
        isLaunchpad: t.is_launchpad === true,
        symbol: typeof t.symbol === 'string' ? t.symbol : '',
        ts: Date.now()
      });
    }
    prune(market);
  };

  // Map metadata links onto the title vocabulary the DOM cards use, so
  // scoreCard weighs API evidence exactly like on-card social icons. Matched
  // against the URL and any label the payload carries.
  const TITLE_BY_MATCH = [
    [/github\.com/i, 'GitHub'],
    [/medium\.com/i, 'Medium'],
    [/youtube\.com|youtu\.be/i, 'YouTube'],
    [/docs?\.|gitbook|readme/i, 'Docs'],
    [/discord\.(gg|com)/i, 'Discord']
  ];
  // MCP carries the highest utility weight (4 in score.js) but rarely has a
  // recognizable host — it identifies by label ("MCP") or an mcp path token.
  const isMcp = (text) =>
    /(^|[^a-z])mcp([^a-z]|$)|model.?context.?protocol/i.test(text);

  const takeMetadata = (data) => {
    for (const [key, m] of Object.entries(data)) {
      if (!m || typeof m !== 'object') continue;
      const list = new Set();
      if (typeof m.website_url === 'string' && m.website_url) list.add('Website');
      if (typeof m.discord_url === 'string' && m.discord_url) list.add('Discord');
      const extras = Array.isArray(m.extra_links) ? m.extra_links
        : m.extra_links && typeof m.extra_links === 'object'
          ? Object.values(m.extra_links) : [];
      for (const link of extras) {
        const url = typeof link === 'string' ? link
          : (link && (link.url || link.href)) || '';
        const label = link && typeof link === 'object'
          ? String(link.label || link.name || link.type || '') : '';
        const hit = TITLE_BY_MATCH.find(([re]) => re.test(url) || re.test(label));
        if (hit) list.add(hit[1]);
        if (isMcp(url) || isMcp(label)) list.add('MCP');
      }
      if (list.size) titles.set(normAddr(key), { list: [...list], ts: Date.now() });
    }
    prune(titles);
  };

  const takePrices = (data) => {
    const next = {};
    for (const [sym, v] of Object.entries(data)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) next[sym] = n;
    }
    if (Object.keys(next).length) prices = next;
  };

  const takeTick = (data) => {
    const tick = adaptTick(data);
    if (!tick) return;
    ticks.set(normAddr(tick.addr), {
      priceUsd: tick.priceUsd,
      mcapUsd: tick.mcapUsd,
      ts: Date.now()
    });
    prune(ticks);
  };

  // REST is the live price source: the swap WebSocket runs inside a Web Worker
  // (see docs/dump-alerts.md) so the MAIN-world tap never sees it. dump.js polls
  // the tape for held positions anyway — feed the newest confirmed trade's
  // price_usd straight into the same cache the price consumers read. No market
  // cap on a trade row, so that stays null.
  // One /trades page covers minutes, not a token's life, so any question about
  // wallet behaviour over time needs history we keep ourselves. The polls that
  // already run carry the rows; this stops throwing all but the newest away.
  // There is no backfill: history starts when the tab does.
  const TAPE_MAX_ROWS = 1500;
  const TAPE_TTL_MS = 60 * 60 * 1000;
  const tapes = new Map(); // addr -> { rows, seen: Set<txHash>, ts }

  const noteTrades = (addr, trades) => {
    if (!isAddr(addr) || !Array.isArray(trades)) return;
    const key = normAddr(addr);
    let tape = tapes.get(key);
    if (!tape) {
      tape = { rows: [], seen: new Set(), ts: 0 };
      tapes.set(key, tape);
    }
    tape.ts = Date.now();

    for (const t of trades) {
      if (!t || typeof t !== 'object' || t.preconfirm === true) continue;
      // tx_hash is the only stable identity across overlapping poll pages.
      const txHash = typeof t.tx_hash === 'string' ? t.tx_hash : null;
      if (!txHash || tape.seen.has(txHash)) continue;
      const ts = BBD.parseTradeTimestamp(t.timestamp);
      if (ts === null) continue;
      tape.seen.add(txHash);
      tape.rows.push({
        ts,
        txHash,
        trader: typeof t.trader_full === 'string' ? t.trader_full : '',
        isBuy: t.is_buy === true,
        volumeUsd: usd(t.volume_usd) || 0,
        isPro: t.is_pro_trader === true,
        isSniper: t.is_sniper === true
      });
    }

    const cutoff = tape.ts - TAPE_TTL_MS;
    if (tape.rows.length > TAPE_MAX_ROWS ||
      (tape.rows.length && tape.rows[0].ts < cutoff)) {
      let rows = tape.rows.filter((row) => row.ts >= cutoff);
      rows.sort((a, b) => a.ts - b.ts);
      if (rows.length > TAPE_MAX_ROWS) rows = rows.slice(rows.length - TAPE_MAX_ROWS);
      tape.rows = rows;
      tape.seen = new Set(rows.map((row) => row.txHash));
    }
    prune(tapes);
  };

  // Returns rows oldest-first; callers reason about ordering, not arrival.
  const tapeFor = (addr) => {
    if (!addr) return [];
    const tape = tapes.get(normAddr(addr));
    if (!tape) return [];
    const cutoff = Date.now() - TAPE_TTL_MS;
    return tape.rows
      .filter((row) => row.ts >= cutoff)
      .sort((a, b) => a.ts - b.ts);
  };

  const notePrice = (addr, trades) => {
    if (!isAddr(addr) || !Array.isArray(trades)) return;
    let bestTs = -Infinity;
    let bestPrice = null;
    for (const t of trades) {
      if (!t || typeof t !== 'object' || t.preconfirm === true) continue;
      const ts = BBD.parseTradeTimestamp(t.timestamp);
      if (ts === null || ts <= bestTs) continue;
      const price = usd(t.price_usd);
      if (price === null || price <= 0) continue;
      bestTs = ts;
      bestPrice = price;
    }
    if (bestPrice === null) return;
    ticks.set(normAddr(addr), { priceUsd: bestPrice, mcapUsd: null, ts: Date.now() });
    prune(ticks);
  };

  // Reduce one token's audit block to a safety verdict. "danger" means funds
  // are at real risk: the token contract is flagged unsafe, or its hook carries
  // a critical vulnerability (owner can drain liquidity / trap LPs / levy hidden
  // fees) — signals no holder stat exposes.
  const CRIT = new Set(['critical']);
  const evalAudit = (a) => {
    if (!a || typeof a !== 'object') return null;
    const vulns = a.hookAudit && Array.isArray(a.hookAudit.vulnerabilities)
      ? a.hookAudit.vulnerabilities : [];
    const criticals = vulns.filter((v) => v && CRIT.has(v.impact));
    const hookUnsafe = a.hookAudit ? a.hookAudit.isSafe === false : false;
    const tokenUnsafe = a.isTokenSafe === false;
    const danger = tokenUnsafe || (hookUnsafe && criticals.length > 0);
    const reasons = [];
    if (tokenUnsafe) reasons.push('token contract flagged unsafe');
    for (const v of criticals.slice(0, 2)) {
      reasons.push(typeof v.description === 'string' && v.description
        ? v.description.replace(/\s+/g, ' ').slice(0, 90)
        : (v.type || 'critical hook risk'));
    }
    return {
      danger,
      critical: criticals.length > 0,
      ownerRenounced: a.ownerRenounced === true,
      reasons,
      ts: Date.now()
    };
  };
  const takeAudit = (objs) => {
    if (!Array.isArray(objs)) return;
    for (const o of objs) {
      if (!o || o.done || !isAddr(o.address) || !o.data) continue;
      const v = evalAudit(o.data.audit);
      if (v) audit.set(normAddr(o.address), v);
    }
    prune(audit);
  };

  const rememberPool = (addr, poolRaw, chainRaw, replace) => {
    if (!isAddr(addr)) return;
    const pool = poolId(poolRaw);
    const chain = chainRaw === null || chainRaw === undefined ? null : chainId(chainRaw);
    if (!pool || (chainRaw !== null && chainRaw !== undefined && !chain)) return;
    const key = normAddr(addr);
    const current = pools.get(key);
    // The URL is verified; an unverified balance candidate may only fill a
    // miss, or add a chain to the same pool without replacing URL evidence.
    if (!replace && current) {
      if (current.pool === pool && !current.chain && chain) {
        pools.set(key, { pool, chain, ts: Date.now() });
      }
      return;
    }
    pools.set(key, { pool, chain, ts: Date.now() });
    prune(pools);
  };

  const takePool = (data) => {
    if (!data || typeof data !== 'object' || data.chain === null || data.chain === undefined) return;
    rememberPool(data.addr, data.pool, data.chain, true);
  };

  // Wallet holdings (/api/v1/balances): the authoritative position list with
  // accurate unrealized PnL — pnl.js uses this over fragile DOM scraping. Each
  // token: { token, symbol, valueUsd, pnl:{ relative(%), absolute($) }, pool }.
  const takeBalances = (wallets) => {
    if (!Array.isArray(wallets)) return;
    const next = new Map();
    const sourceTs = Date.now();
    wallets.forEach((w, walletIndex) => {
      const toks = w && Array.isArray(w.tokens) ? w.tokens : [];
      const walletRaw = w && (w.wallet || w.walletAddress || w.address || w.owner);
      const wallet = isAddr(walletRaw) ? normAddr(walletRaw) : `wallet${walletIndex}`;
      for (const t of toks) {
        if (!t || !isAddr(t.token)) continue;
        const addr = normAddr(t.token);
        const rel = t.pnl && Number(t.pnl.relative);
        const abs = t.pnl && Number(t.pnl.absolute);
        const poolData = t.pool && typeof t.pool === 'object' && !Array.isArray(t.pool)
          ? t.pool : null;
        const chainRaw = (poolData && poolData.chain) || t.network;
        const chain = chainId(chainRaw);
        // The balance pool shape is unverified, so accept only a candidate that
        // validates as an opaque id and never replace the observed request URL.
        if (poolData) {
          const fields = ['id', 'address', 'pool', 'poolId', 'pool_address'];
          const candidate = fields.map((field) => poolId(poolData[field])).find(Boolean);
          if (candidate) rememberPool(addr, candidate, chain, false);
        }
        const positionKey = BBD.positionKey(addr, chain, wallet);
        next.set(positionKey, {
          positionKey,
          addr,
          symbol: typeof t.symbol === 'string' ? t.symbol : '',
          pct: Number.isFinite(rel) ? rel : null,
          pnlUsd: Number.isFinite(abs) ? abs : null,
          valueUsd: usd(t.valueUsd),
          chain,
          wallet,
          sourceTs
        });
      }
    });
    balances.clear();
    for (const [k, v] of next) balances.set(k, v);
    balancesTs = sourceTs;
    balancesSeen = true; // an empty holdings list is still authoritative (all sold)
  };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const msg = ev.data;
    if (!msg || msg.__bbd !== 'api' || !msg.data || typeof msg.data !== 'object') return;
    if (msg.kind === 'metrics') takeMetrics(msg.data);
    else if (msg.kind === 'metadata') takeMetadata(msg.data);
    else if (msg.kind === 'list') takeList(msg.data);
    else if (msg.kind === 'prices') takePrices(msg.data);
    else if (msg.kind === 'audit') takeAudit(msg.data);
    else if (msg.kind === 'balances') takeBalances(msg.data);
    else if (msg.kind === 'tick') takeTick(msg.data);
    else if (msg.kind === 'pool') takePool(msg.data);
  });
  // The load-time batches fired before this listener existed.
  window.postMessage({ __bbd: 'replay-request' }, location.origin);

  const statsFor = (addr) => {
    if (!addr) return null;
    const e = stats.get(normAddr(addr));
    return e && Date.now() - e.ts < STATS_TTL_MS ? e : null;
  };
  // Every writer keys these maps through normAddr, so every reader must too:
  // a caller holding a checksummed EVM address would otherwise miss a cached
  // entry and read as "not loaded yet" — which the advisor and scalp readout
  // cannot distinguish from "nothing to report".
  // Social links never really expire; ts is only used for pruning.
  const titlesFor = (addr) => (addr && titles.get(normAddr(addr))?.list) || [];
  // Creator address and last-seen market for the creator guard. No TTL: these
  // are reference facts, and the guard's own history is what carries meaning.
  const creatorFor = (addr) => (addr && creator.get(normAddr(addr))) || null;
  const marketFor = (addr) => (addr && market.get(normAddr(addr))) || null;
  const auditFor = (addr) => (addr && audit.get(normAddr(addr))) || null;
  const priceOf = (sym) => (sym && prices[sym]) || null;
  const ethPrice = () => prices.ETH || null;
  const tickFor = (addr) => {
    if (!addr) return null;
    const tick = ticks.get(normAddr(addr));
    return tick && Date.now() - tick.ts < TICK_TTL_MS ? tick : null;
  };
  // Held positions from the balances API. Freshness gates pnl.js switching off
  // DOM fallback — until the first fetch is tapped, "no positions" cannot be
  // distinguished from "not loaded yet".
  const heldPositions = () => [...balances.values()].map((v) => ({ ...v }));
  const hasBalances = () => balancesSeen;
  const hasFreshBalances = () => balancesSeen && Date.now() - balancesTs < BBD.BALANCES_TTL_MS;
  const balancesUpdatedAt = () => balancesTs || null;
  // Pool ids are routing facts that stay stable for a token; keep them without
  // a TTL so opening a token once can enable later held-position polling.
  const poolFor = (addr) => (addr && pools.get(normAddr(addr))) || null;

  return {
    statsFor, titlesFor, creatorFor, marketFor, auditFor, priceOf, ethPrice,
    tickFor, adaptTick, notePrice, noteTrades, tapeFor,
    heldPositions, hasBalances, hasFreshBalances, balancesUpdatedAt,
    poolFor
  };
})();
