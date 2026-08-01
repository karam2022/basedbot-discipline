// MAIN-world fetch / WebSocket tap. The SPA receives every card stat as JSON
// (/api/tokens/metrics/batch: top10/dev/snipers/bundlers/insiders/holders/
// dexPaid) and every social link (/api/tokens/metadata*). Reading those
// payloads is immune to layout redesigns that silently break positional
// innerText parsing. Runs at document_start so the patch is installed before
// the app's first fetch; ships payloads to the ISOLATED world via postMessage
// (the only bridge between worlds).
'use strict';

(() => {
  // BasedBot serves EVM chains from basedbot.app/api/* and Solana from
  // basedbot-api.mobula.io/api/2/* — a different backend with different
  // payload shapes, not just different values. Tapping only the first set is
  // why the feed cache was empty on Solana (docs/solana-support.md §2).
  const MOBULA = 'basedbot-api.mobula.io';
  const WATCHED = [
    [/\/api\/tokens\/metrics\/batch$/, 'metrics'],
    [/\/api\/tokens\/metadata(\/batch)?$/, 'metadata'],
    [/\/api\/tokens$/, 'list'],        // feed list: liquidity_usd, market_cap_usd per token
    [/\/api\/prices$/, 'prices'],      // { success, prices: { ETH: number, ... } }
    [/\/api\/audit\/batch$/, 'audit'], // streamed audit objects (contract + hook safety)
    [/\/api\/v1\/balances$/, 'balances'], // wallet holdings + unrealized PnL per token
    // --- Solana (Mobula) counterparts ---
    // security replaces BOTH metrics/batch and audit/batch: holder
    // concentration plus isMintable/isFreezable, the SPL authorities that are
    // Solana's honeypot switch.
    [/^\/api\/2\/token\/security$/, 'security', MOBULA],
    // The Solana tape. /api/token/{a}/trades answers 500 on Solana, so this
    // tap is the only live trade source there.
    [/^\/api\/2\/token\/trades$/, 'svmtrades', MOBULA],
    // The Solana feed list: every card stat, the market, the pool, the socials
    // and the deployer in one payload (new / bonding / bonded buckets).
    [/^\/api\/2\/pulse$/, 'pulse', MOBULA],
    // Every token the open token's creator has launched, with the authoritative
    // total in pagination.total.
    [/^\/api\/2\/wallet\/deployer$/, 'deployer', MOBULA],
    // Per-token positions + poolInfo. The Solana token page has no tappable
    // /api/token/{a}/trades request, so this is where the pool id comes from.
    [/^\/api\/v1\/monitor\/[^/]+$/, 'monitor', 'api.basedbot.app']
    // Not tapped yet — api/2/pulse (feed list), api/2/token/details (socials)
    // and api/2/wallet/deployer (creator history) all exist on Solana, but
    // their payload shapes are unverified. They stay out of WATCHED until an
    // adapter can consume them: every kind added here competes for the
    // 40-slot replay buffer that exists to preserve the load-time batches.
  ];

  // Chain-specific stream names can change; the BasedBot + Mobula hostname
  // relationship is the stable boundary, not today's sol suffix.
  const isWatchedSocket = (url) => {
    try {
      const hostname = new URL(String(url), location.origin).hostname.toLowerCase();
      return hostname.endsWith('.mobula.io') && hostname.includes('basedbot');
    } catch (err) {
      return false;
    }
  };

  // /api/audit/batch streams multiple JSON objects (NDJSON / concatenated),
  // ending with {done:true} — not a single JSON body. Pull out each balanced
  // top-level object so response.json() (which would choke) is never used.
  const parseJsonStream = (text) => {
    const out = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') { if (depth === 0) start = i; depth += 1; }
      else if (c === '}') {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try { out.push(JSON.parse(text.slice(start, i + 1))); } catch (e) { /* skip */ }
          start = -1;
        }
      }
    }
    return out;
  };

  // One /api/2/pulse response is three buckets of 100 tokens carrying ~130
  // fields each — several megabytes of trending scores and volume windows the
  // extension never reads. Structured-cloning that through postMessage and
  // holding it in the replay buffer would cost far more than the ~15 fields
  // that matter, so it is projected down here, in the world that already has
  // the object.
  const PULSE_FIELDS = [
    'address', 'chainId', 'symbol', 'name', 'deployer', 'poolAddress',
    'holdersCount', 'proTradersCount', 'top10Holdings', 'devHoldings',
    'snipersHoldings', 'bundlersHoldings', 'insidersHoldings',
    'dexscreenerAdPaid', 'liquidity', 'approximateReserveUSD', 'marketCap',
    'marketCapDiluted', 'bondingPercentage', 'bonded', 'socials'
  ];

  const slimPulse = (json) => {
    if (!json || typeof json !== 'object') return null;
    const out = {};
    for (const [bucket, value] of Object.entries(json)) {
      const rows = value && Array.isArray(value.data) ? value.data : null;
      if (!rows) continue;
      out[bucket] = {
        data: rows.map((row) => {
          if (!row || typeof row !== 'object') return null;
          const slim = {};
          for (const field of PULSE_FIELDS) {
            if (row[field] !== undefined) slim[field] = row[field];
          }
          return slim;
        }).filter(Boolean)
      };
    }
    return Object.keys(out).length ? out : null;
  };

  // Same reasoning for the deployer's 50 positions: only the token identity
  // and the market that decides "rugged" are read.
  const slimDeployer = (json) => {
    if (!json || typeof json !== 'object') return null;
    const rows = Array.isArray(json.data) ? json.data : [];
    const total = json.pagination && json.pagination.total;
    return {
      pagination: { total: typeof total === 'number' ? total : null },
      data: rows.map((row) => {
        const tk = row && row.token;
        if (!tk || typeof tk !== 'object') return null;
        return {
          token: {
            address: tk.address,
            symbol: tk.symbol,
            marketCapUSD: tk.marketCapUSD,
            marketCapDiluted: tk.marketCapDiluted,
            approximateReserveUSD: tk.approximateReserveUSD
          }
        };
      }).filter(Boolean)
    };
  };

  // The ISOLATED-world listener attaches at document_idle, long after the
  // load-time batches fired — buffer everything and replay on request.
  const buffer = [];
  const MAX_BUFFER = 40;

  // Ticks stream continuously, so they never enter the buffer: a replayed price
  // is stale by the time it lands, and buffering them would evict the load-time
  // batches this buffer exists to preserve long before the replay request runs.
  const post = (kind, data) => {
    const msg = { __bbd: 'api', kind, data };
    if (kind !== 'tick') {
      // The page polls one tape repeatedly; retain only its newest mapping so
      // stable pool ids cannot crowd load-time batches out of the replay buffer.
      if (kind === 'pool') {
        const prior = buffer.findIndex((item) =>
          item.kind === 'pool' && item.data && item.data.addr === data.addr);
        if (prior >= 0) buffer.splice(prior, 1);
      }
      buffer.push(msg);
      if (buffer.length > MAX_BUFFER) buffer.shift();
    }
    window.postMessage(msg, location.origin);
  };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    if (ev.data && ev.data.__bbd === 'replay-request') {
      buffer.forEach((msg) => window.postMessage(msg, location.origin));
    }
  });

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = origFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === 'string' ? input
        : input instanceof Request ? input.url
          : input instanceof URL ? input.href : '';
      const parsedUrl = new URL(url, location.origin);
      const path = parsedUrl.pathname;
      const trades = path.match(/^\/api\/token\/(0x[a-fA-F0-9]{6,}|[1-9A-HJ-NP-Za-km-z]{20,})\/trades$/);
      if (trades) {
        const pool = parsedUrl.searchParams.get('pool');
        const chain = parsedUrl.searchParams.get('chain');
        const validPool = typeof pool === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(pool);
        const validChain = typeof chain === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(chain);
        if (validPool && validChain) post('pool', { addr: trades[1], pool, chain });
      }
      const host = parsedUrl.hostname.toLowerCase();
      const hit = WATCHED.find(([re, , wantHost]) =>
        re.test(path) && (!wantHost || host === wantHost));
      if (hit) {
        const kind = hit[1];
        if (kind === 'audit') {
          promise
            .then((resp) => resp.clone().text())
            .then((text) => {
              const objs = parseJsonStream(text);
              if (objs.length) post('audit', objs);
            })
            .catch(() => {});
        } else {
          promise
            .then((resp) => resp.clone().json())
            .then((json) => {
              // prices carries { prices: {...} }; pulse is bucketed at the top
              // level; the rest carry { data: ... }.
              const payload = kind === 'prices' ? (json && json.prices)
                : kind === 'pulse' ? slimPulse(json)
                  : kind === 'deployer' ? slimDeployer(json)
                    : (json && json.data);
              if (payload && typeof payload === 'object') post(kind, payload);
            })
            .catch(() => {}); // the page's own consumer surfaces real errors
        }
      }
    } catch (err) { /* never break the page's fetch */ }
    return promise;
  };

  const origWS = window.WebSocket;
  if (typeof origWS === 'function') {
    const WebSocketTap = function WebSocket(url, protocols) {
      const args = Array.prototype.slice.call(arguments);
      if (!new.target) return Reflect.apply(origWS, this, args);
      const sock = Reflect.construct(origWS, args, new.target);
      if (isWatchedSocket(url)) {
        let debugCount = 0;
        try {
          sock.addEventListener('message', (ev) => {
            try {
              if (typeof ev.data !== 'string') return;
              try {
                if (debugCount < 3 && window.localStorage.getItem('bbd-debug-ws') === '1') {
                  debugCount += 1;
                  console.debug('[bbd] WebSocket message', ev.data);
                }
              } catch (err) { /* debug mode must never affect the page */ }
              let parsed;
              try { parsed = JSON.parse(ev.data); } catch (err) { return; }
              if (parsed && typeof parsed === 'object') post('tick', parsed);
            } catch (err) { /* never break the page's message listener */ }
          });
        } catch (err) { /* never break the page's WebSocket */ }
      }
      return sock;
    };
    WebSocketTap.prototype = origWS.prototype;
    Object.setPrototypeOf(WebSocketTap, Object.getPrototypeOf(origWS));
    for (const key of Reflect.ownKeys(origWS)) {
      if (key === 'prototype') continue;
      try {
        Object.defineProperty(WebSocketTap, key, Object.getOwnPropertyDescriptor(origWS, key));
      } catch (err) { /* keep the wrapper's equivalent built-in property */ }
    }
    window.WebSocket = WebSocketTap;
  }
})();
