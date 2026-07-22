// In-memory cache of the API payloads tapped by interceptor.js (MAIN world).
// Everything arriving via postMessage is untrusted input and re-validated
// here; DOM parsing stays as fallback for anything the cache misses. Shapes
// mirror parseCardStats so consumers can't tell the sources apart.
'use strict';

BBD.feed = (() => {
  // Stats gate 🔥 alerts — stale values must lose to a fresh DOM parse.
  const STATS_TTL_MS = 10 * 60 * 1000;
  const MAX_ENTRIES = 1500;
  const stats = new Map();  // addr -> { holders, pro, top10, ..., paid, ts }
  const titles = new Map(); // addr -> { list: ['Website', ...], ts }

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
      // Same completeness bar as parseCardStats: partial stats can't be
      // trusted to gate safety checks — skip and let the DOM parser try.
      if (entry.holders === null || entry.pro === null) continue;
      if ([entry.top10, entry.dev, entry.snipers, entry.bundlers, entry.insiders]
        .some((v) => v === null)) continue;
      stats.set(normAddr(key), entry);
    }
    prune(stats);
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

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const msg = ev.data;
    if (!msg || msg.__bbd !== 'api' || !msg.data || typeof msg.data !== 'object') return;
    if (msg.kind === 'metrics') takeMetrics(msg.data);
    else if (msg.kind === 'metadata') takeMetadata(msg.data);
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

  return { statsFor, titlesFor };
})();
