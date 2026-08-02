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

test('hook scorer: young named movers rank; templates, dust and dormant are out', () => {
  const now = Date.parse('2026-08-02T00:00:00Z');
  const day = (n) => new Date(now - n * 86400000).toISOString();
  const nodes = [
    { id: '0xnew', label: 'StockPairHook', pools: 6, velocity: 3, accel: 2, status: 'accelerating', verified: 'yes', first: day(4) },
    { id: '0xold', label: 'AncientHook', pools: 40, velocity: 5, accel: 1, status: 'steady', verified: 'yes', first: day(90) },
    { id: '0xtpl', label: 'ClankerHookStaticFeeV2', pools: 400, velocity: 9, accel: 9, status: 'accelerating', verified: 'yes', first: day(2) },
    { id: '0xdust', label: 'TinyHook', pools: 1, velocity: 1, accel: 1, status: 'steady', verified: 'no', first: day(3) },
    { id: '0xdead', label: 'SleepyHook', pools: 5, velocity: 0, accel: 0, status: 'dormant', verified: 'yes', first: day(5) },
    { id: '0xanon', label: '', pools: 9, velocity: 4, accel: 3, status: 'accelerating', verified: 'no', first: day(1) },
    { id: '0xok', label: 'QuietNewHook', pools: 2, velocity: 0.5, accel: 0.1, status: 'steady', verified: 'no', first: day(10) }
  ];
  const top = bbdScoreHooks(nodes, now);
  const names = top.map((h) => h.name);
  assert.deepEqual(names, ['StockPairHook', 'QuietNewHook'],
    'only young, named, multi-pool, non-template, non-dormant hooks survive — ranked by score');
  assert.equal(top[0].verified, true);
  assert.equal(top[0].ageDays, 4);
});
