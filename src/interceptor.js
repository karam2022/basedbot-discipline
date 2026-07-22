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
    [/\/api\/tokens\/metadata(\/batch)?$/, 'metadata']
  ];

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
        promise
          .then((resp) => resp.clone().json())
          .then((json) => {
            if (json && typeof json.data === 'object' && json.data !== null) {
              post(hit[1], json.data);
            }
          })
          .catch(() => {}); // the page's own consumer surfaces real errors
      }
    } catch (err) { /* never break the page's fetch */ }
    return promise;
  };
})();
