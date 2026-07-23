// MAIN-world fetch / WebSocket tap. The SPA receives every card stat as JSON
// (/api/tokens/metrics/batch: top10/dev/snipers/bundlers/insiders/holders/
// dexPaid) and every social link (/api/tokens/metadata*). Reading those
// payloads is immune to layout redesigns that silently break positional
// innerText parsing. Runs at document_start so the patch is installed before
// the app's first fetch; ships payloads to the ISOLATED world via postMessage
// (the only bridge between worlds).
'use strict';

(() => {
  const WATCHED = [
    [/\/api\/tokens\/metrics\/batch$/, 'metrics'],
    [/\/api\/tokens\/metadata(\/batch)?$/, 'metadata'],
    [/\/api\/tokens$/, 'list'],        // feed list: liquidity_usd, market_cap_usd per token
    [/\/api\/prices$/, 'prices'],      // { success, prices: { ETH: number, ... } }
    [/\/api\/audit\/batch$/, 'audit'], // streamed audit objects (contract + hook safety)
    [/\/api\/v1\/balances$/, 'balances'] // wallet holdings + unrealized PnL per token
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
      const hit = WATCHED.find(([re]) => re.test(path));
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
              // prices carries { prices: {...} }; the rest carry { data: ... }.
              const payload = kind === 'prices' ? (json && json.prices) : (json && json.data);
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
