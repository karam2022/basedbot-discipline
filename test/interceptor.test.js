// MAIN-world interception: WebSocket wrapping must stay transparent to the
// page while watched Mobula messages cross the existing buffered bridge.
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

const setup = ({ throwOnListen = false } = {}) => {
  const posts = [];
  const windowListeners = {};
  function FakeWebSocket(...args) {
    if (!new.target) throw new TypeError('WebSocket must be constructed');
    this.args = args;
    this.listeners = {};
  }
  FakeWebSocket.prototype.addEventListener = function (type, fn) {
    if (throwOnListen && type === 'message') throw new Error('listener rejected');
    (this.listeners[type] ||= []).push(fn);
  };
  FakeWebSocket.prototype.emit = function (type, ev) {
    (this.listeners[type] || []).forEach((fn) => fn(ev));
  };
  Object.defineProperty(FakeWebSocket, 'OPEN', {
    value: 1, enumerable: false, configurable: false, writable: false
  });

  global.location = { origin: 'https://basedbot.app' };
  global.window = {
    WebSocket: FakeWebSocket,
    fetch: () => Promise.resolve({}),
    localStorage: { getItem: () => null },
    addEventListener: (type, fn) => {
      (windowListeners[type] ||= []).push(fn);
    },
    postMessage: (msg, origin) => posts.push({ msg, origin })
  };
  load('src/interceptor.js');
  return {
    OriginalWebSocket: FakeWebSocket,
    PatchedWebSocket: window.WebSocket,
    posts,
    dispatchWindowMessage: (data) => {
      (windowListeners.message || []).forEach((fn) => fn({
        source: window, origin: location.origin, data
      }));
    }
  };
};

test('patched WebSocket constructs with original prototype, statics, and arguments', () => {
  const { OriginalWebSocket, PatchedWebSocket } = setup();
  const one = new PatchedWebSocket('wss://example.test');
  const protocols = ['json', 'binary'];
  const two = new PatchedWebSocket('wss://example.test', protocols);

  assert.equal(PatchedWebSocket.prototype, OriginalWebSocket.prototype);
  assert.equal(Object.getPrototypeOf(one), OriginalWebSocket.prototype);
  assert.equal(one instanceof OriginalWebSocket, true);
  assert.equal(one instanceof PatchedWebSocket, true);
  assert.deepEqual(one.args, ['wss://example.test']);
  assert.deepEqual(two.args, ['wss://example.test', protocols]);
  assert.equal(PatchedWebSocket.OPEN, OriginalWebSocket.OPEN);
  assert.deepEqual(Object.getOwnPropertyDescriptor(PatchedWebSocket, 'OPEN'),
    Object.getOwnPropertyDescriptor(OriginalWebSocket, 'OPEN'));
  assert.throws(() => PatchedWebSocket('wss://example.test'), /constructed/);
});

test('both BasedBot Mobula host patterns are tapped and unrelated hosts are not', () => {
  const { PatchedWebSocket } = setup();
  const generic = new PatchedWebSocket('wss://basedbot-api.mobula.io');
  const solana = new PatchedWebSocket('wss://basedbot-swap-enriched-stream-sol.mobula.io/');
  const plausibleBase = new PatchedWebSocket('wss://basedbot-swap-enriched-stream-base.mobula.io/');
  const unrelated = new PatchedWebSocket('wss://stream.mobula.io/');
  const lookalike = new PatchedWebSocket('wss://basedbot.mobula.io.example.test/');

  assert.equal(generic.listeners.message.length, 1);
  assert.equal(solana.listeners.message.length, 1);
  assert.equal(plausibleBase.listeners.message.length, 1);
  assert.equal(unrelated.listeners.message, undefined);
  assert.equal(lookalike.listeners.message, undefined);
});

test('a JSON message posts exactly one parsed object', () => {
  const { PatchedWebSocket, posts } = setup();
  const sock = new PatchedWebSocket('wss://basedbot-api.mobula.io');
  sock.emit('message', { data: '{"address":"0xabc123","price_usd":1.25}' });

  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], {
    msg: {
      __bbd: 'api',
      kind: 'tick',
      data: { address: '0xabc123', price_usd: 1.25 }
    },
    origin: 'https://basedbot.app'
  });
});

test('malformed, binary, throwing message data and listener setup never escape', () => {
  const { PatchedWebSocket, posts } = setup();
  const sock = new PatchedWebSocket('wss://basedbot-api.mobula.io');
  assert.doesNotThrow(() => sock.emit('message', { data: '{nope' }));
  assert.doesNotThrow(() => sock.emit('message', { data: new Uint8Array([1, 2]) }));
  const throwingEvent = {};
  Object.defineProperty(throwingEvent, 'data', { get: () => { throw new Error('bad event'); } });
  assert.doesNotThrow(() => sock.emit('message', throwingEvent));
  assert.equal(posts.length, 0);

  const throwingSetup = setup({ throwOnListen: true });
  assert.doesNotThrow(() =>
    new throwingSetup.PatchedWebSocket('wss://basedbot-api.mobula.io'));
});

// The buffer exists so the ISOLATED listener, which attaches at document_idle,
// still sees the load-time batches. Ticks stream continuously: buffering them
// would evict those batches (MAX_BUFFER is 40) long before the replay request.
test('streamed ticks never enter the replay buffer', () => {
  const { PatchedWebSocket, posts, dispatchWindowMessage } = setup();
  const sock = new PatchedWebSocket('wss://basedbot-api.mobula.io');
  for (let i = 0; i < 50; i++) {
    sock.emit('message', { data: `{"payload":{"token":"0xabc123","price":${i + 1}}}` });
  }
  assert.equal(posts.length, 50);

  dispatchWindowMessage({ __bbd: 'replay-request' });
  assert.equal(posts.length, 50, 'a replayed price is stale — ticks must not replay');
});
