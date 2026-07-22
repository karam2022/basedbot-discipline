// MAIN-world fetch tap. The SPA receives every card stat as JSON
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
    [/\/api\/tokens$/, 'list'],       // feed list: liquidity_usd, market_cap_usd per token
    [/\/api\/prices$/, 'prices'],     // { success, prices: { ETH: number, ... } }
    [/\/api\/audit\/batch$/, 'audit'] // streamed audit objects (contract + hook safety)
  ];

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

  const post = (kind, data) => {
    const msg = { __bbd: 'api', kind, data };
    buffer.push(msg);
    if (buffer.length > MAX_BUFFER) buffer.shift();
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
      const path = new URL(url, location.origin).pathname;
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
})();
