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

load('src/constants.js');
load('src/provider.js');
// The worker gets this through importScripts, which the harness stubs out.
load('src/riskfloor.js');
global.importScripts = () => undefined;

const state = {
  settings: { tgToken: '123:abc', tgChatId: '999' },
  alerted: {},
  positions: {},
  positionsMeta: {}
};
let telegramOk = false;
let messageListener;
let fetchImpl;

const pick = (keys) => {
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
  return Object.fromEntries(list.map((k) => [k, state[k]]));
};

global.chrome = {
  storage: { local: {
    get: async (keys) => pick(keys),
    set: async (patch) => Object.assign(state, patch)
  } },
  runtime: { onMessage: { addListener: (fn) => { messageListener = fn; } } },
  notifications: {
    create: async () => 'notification-id',
    onClicked: { addListener: () => undefined },
    clear: async () => undefined
  },
  tabs: { create: async () => undefined }
};
const telegramFetch = async () => ({
  ok: telegramOk,
  status: telegramOk ? 200 : 503,
  json: async () => ({ result: [] })
});
fetchImpl = telegramFetch;
global.fetch = (...args) => fetchImpl(...args);

const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
// eslint-disable-next-line no-eval
(0, eval)(src);

const send = (msg) => new Promise((resolve, reject) => {
  const keepAlive = messageListener(msg, {}, resolve);
  if (!keepAlive) reject(new Error('listener did not keep the async response alive'));
});

test('failed Telegram delivery is not deduplicated', async () => {
  fetchImpl = telegramFetch;
  telegramOk = false;
  const warn = console.warn;
  console.warn = () => undefined;
  const failed = await send({
      type: 'bbd-notify', target: 'telegram', dedupe: { key: 'hot:base:0xabc123' },
      title: 'test', message: 'test'
    })
    .finally(() => { console.warn = warn; });
  assert.equal(failed.ok, false);
  assert.equal(state.alerted['hot:base:0xabc123'], undefined);

  telegramOk = true;
  const sent = await send({
    type: 'bbd-notify', target: 'telegram', dedupe: { key: 'hot:base:0xabc123' },
    title: 'test', message: 'test'
  });
  assert.equal(sent.ok, true);
  assert.equal(typeof state.alerted['hot:base:0xabc123'].ts, 'number');
});

test('an older tab cannot overwrite a newer position snapshot', async () => {
  const current = {
    'base|wallet0|0xabcdef123456': {
      addr: '0xabcdef123456', symbol: 'NEW', pct: 10, chain: 'base',
      wallet: 'wallet0', sourceTs: 200
    }
  };
  const accepted = await send({ type: 'bbd-sync-positions', sourceTs: 200, positions: current });
  assert.equal(accepted.accepted, true);
  const stale = await send({ type: 'bbd-sync-positions', sourceTs: 100, positions: {} });
  assert.equal(stale.accepted, false);
  assert.equal(state.positions['base|wallet0|0xabcdef123456'].symbol, 'NEW');
});

test('advisor returns a validated verdict and sends the key only in the auth header', async () => {
  const apiKey = 'sk-test-advisor-success';
  state.settings = {
    ...state.settings,
    advisorEnabled: true,
    advisorProvider: 'openai',
    advisorBaseUrl: 'https://provider.test/v1',
    advisorModel: 'synthetic-model',
    advisorApiKey: apiKey
  };
  let fetchArgs;
  fetchImpl = async (...args) => {
    fetchArgs = args;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              risk: 'high',
              headline: 'Synthetic concentration needs caution.',
              supports: ['Liquidity is present.'],
              against: ['Top wallets remain concentrated.'],
              watchFor: ['A developer sell.'],
              confidence: 'medium'
            })
          }
        }]
      })
    };
  };

  const response = await send({
    type: 'bbd-advisor-verdict',
    snapshot: { symbol: 'TEST', safety: { top10: 20 } }
  });

  assert.deepEqual(response, {
    ok: true,
    verdict: {
      risk: 'high',
      headline: 'Synthetic concentration needs caution.',
      supports: ['Liquidity is present.'],
      against: ['Top wallets remain concentrated.'],
      watchFor: ['A developer sell.'],
      confidence: 'medium'
    }
  });
  assert.equal(fetchArgs[0], 'https://provider.test/v1/chat/completions');
  assert.equal(fetchArgs[1].headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(JSON.stringify(response).includes(apiKey), false);
});

test('advisor passes the configured max tokens and thinking-disable into the request', async () => {
  state.settings = {
    ...state.settings,
    advisorEnabled: true,
    advisorProvider: 'glm',
    advisorBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
    advisorModel: 'GLM-5.2',
    advisorApiKey: 'sk-test-advisor-glm',
    advisorMaxTokens: 8000,
    advisorNoThinking: true
  };
  let sentBody;
  fetchImpl = async (_url, init) => {
    sentBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              risk: 'medium', headline: 'ok', supports: [], against: ['thin data'],
              watchFor: [], confidence: 'low'
            })
          }
        }]
      })
    };
  };

  const response = await send({ type: 'bbd-advisor-verdict', snapshot: { symbol: 'TEST' } });
  assert.equal(response.ok, true);
  assert.equal(sentBody.max_tokens, 8000);
  assert.deepEqual(sentBody.thinking, { type: 'disabled' });
});

test('advisor skips fetch when disabled or missing configuration', async () => {
  let fetchCalls = 0;
  fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error('fetch should not run');
  };
  const configured = {
    ...state.settings,
    advisorProvider: 'openai',
    advisorBaseUrl: 'https://provider.test/v1',
    advisorModel: 'synthetic-model',
    advisorApiKey: 'sk-test-disabled'
  };

  state.settings = { ...configured, advisorEnabled: false };
  const disabled = await send({ type: 'bbd-advisor-verdict', snapshot: { symbol: 'TEST' } });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.reason, 'advisor not configured');

  state.settings = { ...configured, advisorEnabled: true, advisorModel: '' };
  const missing = await send({ type: 'bbd-advisor-verdict', snapshot: { symbol: 'TEST' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'advisor not configured');
  assert.equal(fetchCalls, 0);
});

test('advisor returns non-2xx provider errors without leaking the key', async () => {
  const apiKey = 'sk-test-advisor-rejected';
  state.settings = {
    ...state.settings,
    advisorEnabled: true,
    advisorProvider: 'openai',
    advisorBaseUrl: 'https://provider.test/v1',
    advisorModel: 'synthetic-model',
    advisorApiKey: apiKey
  };
  fetchImpl = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: `Rejected credential ${apiKey}` } })
  });

  const response = await send({
    type: 'bbd-advisor-verdict',
    snapshot: { symbol: 'TEST' }
  });

  assert.equal(response.ok, false);
  assert.match(response.reason, /Rejected credential/);
  assert.equal(JSON.stringify(response).includes(apiKey), false);
});

test('advisor connection test returns status without returning the verdict', async () => {
  state.settings = {
    ...state.settings,
    advisorEnabled: false,
    advisorProvider: 'openai',
    advisorBaseUrl: 'https://provider.test/v1',
    advisorModel: 'synthetic-model',
    advisorApiKey: 'sk-test-advisor-connection'
  };
  fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            risk: 'low',
            headline: 'Synthetic endpoint works.',
            supports: ['The response is valid.'],
            against: ['This is only a connection test.'],
            watchFor: [],
            confidence: 'low'
          })
        }
      }]
    })
  });

  assert.deepEqual(await send({ type: 'bbd-advisor-test' }), { ok: true });
});

test('advisor connection test passes on a reply that is text but not a verdict', async () => {
  state.settings = {
    ...state.settings,
    advisorEnabled: false,
    advisorProvider: 'openai',
    advisorBaseUrl: 'https://provider.test/v1',
    advisorModel: 'synthetic-model',
    advisorApiKey: 'sk-test-advisor-textonly'
  };
  // A reachable model that answers in prose (no usable verdict) still proves the
  // connection — the test must not fail just because the tiny snapshot yielded
  // no counter-arguments.
  fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'The test token has too little data to assess.' } }]
    })
  });

  assert.deepEqual(await send({ type: 'bbd-advisor-test' }), { ok: true });
});

test('a real verdict request surfaces a key-redacted snippet when unparseable', async () => {
  const apiKey = 'sk-test-advisor-snippet';
  state.settings = {
    ...state.settings,
    advisorEnabled: true,
    advisorProvider: 'openai',
    advisorBaseUrl: 'https://provider.test/v1',
    advisorModel: 'synthetic-model',
    advisorApiKey: apiKey
  };
  fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: `No JSON here, and my own key ${apiKey} leaked into the prose.` } }]
    })
  });

  const response = await send({ type: 'bbd-advisor-verdict', snapshot: { symbol: 'TEST' } });
  assert.equal(response.ok, false);
  assert.match(response.reason, /could not parse a verdict/);
  assert.match(response.reason, /No JSON here/);
  assert.equal(JSON.stringify(response).includes(apiKey), false);
});

test('the risk floor is applied to the verdict the worker hands back', async () => {
  const apiKey = 'sk-test-advisor-floor';
  state.settings = {
    ...state.settings,
    advisorEnabled: true,
    advisorProvider: 'openai',
    advisorBaseUrl: 'https://provider.test/v1',
    advisorModel: 'synthetic-model',
    advisorApiKey: apiKey
  };
  const reply = (risk) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        risk,
        headline: 'No observable danger to a fast exit.',
        supports: [],
        against: ['Zero taxes and healthy buy pressure.'],
        watchFor: [],
        confidence: 'medium'
      }) } }]
    })
  });

  // The reported case: the page flags the contract, the model still says low.
  fetchImpl = reply('low');
  const raised = await send({
    type: 'bbd-advisor-verdict',
    snapshot: { symbol: 'TEST', audit: { danger: true }, safety: { taxSell: 0 } }
  });
  assert.equal(raised.verdict.risk, 'high');
  assert.equal(raised.verdict.raisedFrom, 'low');
  assert.match(raised.verdict.raisedReason, /contract flagged unsafe/);

  // A clean snapshot must pass through untouched, or the floor is just noise.
  fetchImpl = reply('low');
  const clean = await send({
    type: 'bbd-advisor-verdict',
    snapshot: {
      symbol: 'TEST',
      audit: { danger: false, critical: false },
      safety: { taxSell: 0, lpBurned: 100, lpLocked: 0 }
    }
  });
  assert.equal(clean.verdict.risk, 'low');
  assert.equal(clean.verdict.raisedReason, undefined);
});
