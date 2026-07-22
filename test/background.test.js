const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const state = {
  settings: { tgToken: '123:abc', tgChatId: '999' },
  alerted: {},
  positions: {},
  positionsMeta: {}
};
let telegramOk = false;
let messageListener;

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
global.fetch = async () => ({
  ok: telegramOk,
  status: telegramOk ? 200 : 503,
  json: async () => ({ result: [] })
});

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
// eslint-disable-next-line no-eval
(0, eval)(src);

const send = (msg) => new Promise((resolve, reject) => {
  const keepAlive = messageListener(msg, {}, resolve);
  if (!keepAlive) reject(new Error('listener did not keep the async response alive'));
});

test('failed Telegram delivery is not deduplicated', async () => {
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
