// In-memory cache of the API payloads tapped by interceptor.js (MAIN world).
// Everything arriving via postMessage is untrusted input and re-validated
// here; DOM parsing stays as fallback for anything the cache misses. Shapes
// mirror parseCardStats so consumers can't tell the sources apart.
'use strict';

BBD.feed = (() => {
  // Stats gate 🔥 alerts — stale values must lose to a fresh DOM parse.
  const STATS_TTL_MS = 10 * 60 * 1000;
  const MAX_ENTRIES = 1500;
  const stats = new Map();   // addr -> { holders, pro, top10, ..., paid, ts }
  const titles = new Map();  // addr -> { list: ['Website', ...], ts }
  const creator = new Map(); // addr -> creatorAddress (for the creator guard)
  const market = new Map();  // addr -> { liq, mcap, isLaunchpad, symbol, ts }
  const audit = new Map();   // addr -> { danger, critical, ownerRenounced, reasons, ts }
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

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const msg = ev.data;
    if (!msg || msg.__bbd !== 'api' || !msg.data || typeof msg.data !== 'object') return;
    if (msg.kind === 'metrics') takeMetrics(msg.data);
    else if (msg.kind === 'metadata') takeMetadata(msg.data);
    else if (msg.kind === 'list') takeList(msg.data);
    else if (msg.kind === 'prices') takePrices(msg.data);
    else if (msg.kind === 'audit') takeAudit(msg.data);
  });
  // The load-time batches fired before this listener existed.
  window.postMessage({ __bbd: 'replay-request' }, location.origin);

  const statsFor = (addr) => {
    if (!addr) return null;
    const e = stats.get(addr);
    return e && Date.now() - e.ts < STATS_TTL_MS ? e : null;
  };
  // Social links never really expire; ts is only used for pruning.
  const titlesFor = (addr) => (addr && titles.get(addr)?.list) || [];
  // Creator address and last-seen market for the creator guard. No TTL: these
  // are reference facts, and the guard's own history is what carries meaning.
  const creatorFor = (addr) => (addr && creator.get(addr)) || null;
  const marketFor = (addr) => (addr && market.get(addr)) || null;
  const auditFor = (addr) => (addr && audit.get(addr)) || null;
  const priceOf = (sym) => (sym && prices[sym]) || null;
  const ethPrice = () => prices.ETH || null;

  return { statsFor, titlesFor, creatorFor, marketFor, auditFor, priceOf, ethPrice };
})();
