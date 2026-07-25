// The accumulated trade tape has to survive a page reload — restarting the
// wallet sample from zero on every refresh is what makes the readout useless.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const load = (rel) => {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/const BBD = \{\};/, 'global.BBD = global.BBD || {};');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
};

global.location = { origin: 'https://basedbot.app' };
global.window = { addEventListener: () => {}, postMessage: () => {} };
global.BBD = global.BBD || {};
load('src/constants.js');

// A fake store, so a reload is simply "load feed.js again against the same disk".
let disk = {};
BBD.alive = () => true;
BBD.store = {
  async get(key, fallback) {
    return disk[key] === undefined ? fallback : disk[key];
  },
  async set(key, value) {
    disk[key] = JSON.parse(JSON.stringify(value)); // storage round-trips as JSON
  }
};

const freshFeed = () => {
  load('src/feed.js');
  return BBD.feed;
};

const apiTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const ADDR = '0xfacade00000000000000000000000000000001';
const trade = (hash, secondsAgo, trader, isBuy) => ({
  tx_hash: hash,
  timestamp: apiTime(Date.now() - secondsAgo * 1000),
  trader_full: trader,
  is_buy: isBuy,
  volume_usd: 25,
  price_usd: 1
});

test('a flushed tape is restored after a reload', async () => {
  disk = {};
  const before = freshFeed();
  before.noteTrades(ADDR, [
    trade('a', 60, '0xaa', true),
    trade('b', 40, '0xbb', true),
    trade('c', 20, '0xcc', false)
  ]);
  assert.equal(before.tapeFor(ADDR).length, 3);
  await before.flushTapes();
  assert.ok(disk.tape && disk.tape[ADDR], 'tape was written to storage');

  // Reload: a brand new module instance with an empty in-memory buffer.
  const after = freshFeed();
  assert.equal(after.tapeFor(ADDR).length, 0, 'starts empty before hydrating');
  await after.hydrateTapes();
  const rows = after.tapeFor(ADDR);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.txHash), ['a', 'b', 'c']);
  // Field fidelity matters: cohort analysis reads trader, side and volume.
  assert.equal(rows[0].trader, '0xaa');
  assert.equal(rows[0].isBuy, true);
  assert.equal(rows[2].isBuy, false);
  assert.equal(rows[0].volumeUsd, 25);
});

test('restored rows dedupe against the first poll after the reload', async () => {
  disk = {};
  const before = freshFeed();
  before.noteTrades(ADDR, [trade('a', 60, '0xaa', true), trade('b', 40, '0xbb', true)]);
  await before.flushTapes();

  const after = freshFeed();
  await after.hydrateTapes();
  // The first poll after a reload returns a page overlapping the stored rows.
  after.noteTrades(ADDR, [trade('b', 40, '0xbb', true), trade('c', 20, '0xcc', false)]);
  assert.deepEqual(after.tapeFor(ADDR).map((r) => r.txHash), ['a', 'b', 'c']);
});

test('hydrating twice cannot double count', async () => {
  disk = {};
  const before = freshFeed();
  before.noteTrades(ADDR, [trade('a', 30, '0xaa', true)]);
  await before.flushTapes();

  const after = freshFeed();
  await Promise.all([after.hydrateTapes(), after.hydrateTapes()]);
  await after.hydrateTapes();
  assert.equal(after.tapeFor(ADDR).length, 1);
});

test('a poll landing before hydration finishes loses nothing', async () => {
  disk = {};
  const before = freshFeed();
  before.noteTrades(ADDR, [trade('a', 60, '0xaa', true)]);
  await before.flushTapes();

  const after = freshFeed();
  const pending = after.hydrateTapes();
  after.noteTrades(ADDR, [trade('z', 5, '0xzz', true)]);
  await pending;
  assert.deepEqual(after.tapeFor(ADDR).map((r) => r.txHash), ['a', 'z']);
});

test('rows past the retention window are not restored', async () => {
  disk = {};
  const before = freshFeed();
  before.noteTrades(ADDR, [trade('fresh', 30, '0xaa', true)]);
  await before.flushTapes();
  // Age the stored row beyond the one-hour window, as a long-closed tab would.
  disk.tape[ADDR].rows[0][0] = Date.now() - 3 * 3600 * 1000;

  const after = freshFeed();
  await after.hydrateTapes();
  assert.equal(after.tapeFor(ADDR).length, 0);
});

test('a corrupt or foreign cache degrades to an empty buffer', async () => {
  for (const bad of [null, 'nope', 42, { [ADDR]: null }, { [ADDR]: { rows: 'x' } },
    { [ADDR]: { rows: [[], [1], ['x', 'y']] } }]) {
    disk = { tape: bad };
    const feed = freshFeed();
    await feed.hydrateTapes();
    assert.deepEqual(feed.tapeFor(ADDR), [], JSON.stringify(bad));
  }
});

test('only the most recent tokens are persisted', async () => {
  disk = {};
  const feed = freshFeed();
  for (let i = 0; i < 10; i++) {
    const addr = `0xfacade000000000000000000000000000000${i}`;
    feed.noteTrades(addr, [trade(`h${i}`, 30 - i, '0xaa', true)]);
  }
  await feed.flushTapes();
  // Six is the documented cap; the buffer keeps more in memory than on disk.
  assert.equal(Object.keys(disk.tape).length, 6);
});

test('the launch page is cached separately and survives a reload', async () => {
  disk = {};
  const before = freshFeed();
  assert.equal(before.hasLaunch(ADDR), false);
  before.noteLaunch(ADDR, [trade('L1', 300, '0xaa', true), trade('L2', 290, '0xbb', true)]);
  assert.equal(before.hasLaunch(ADDR), true);
  assert.equal(before.launchFor(ADDR).length, 2);
  // The rolling buffer must not be polluted by the launch fetch.
  assert.equal(before.tapeFor(ADDR).length, 0);
  await before.flushTapes();

  const after = freshFeed();
  assert.equal(after.hasLaunch(ADDR), false);
  await after.hydrateTapes();
  assert.equal(after.hasLaunch(ADDR), true);
  assert.deepEqual(after.launchFor(ADDR).map((r) => r.txHash), ['L1', 'L2']);
});

test('launch rows ignore the tape retention window', async () => {
  disk = {};
  const before = freshFeed();
  before.noteLaunch(ADDR, [trade('old', 30, '0xaa', true)]);
  await before.flushTapes();
  // A token launched days ago still has a valid, unchanging launch page.
  disk.launch[ADDR].rows[0][0] = Date.now() - 72 * 3600 * 1000;

  const after = freshFeed();
  await after.hydrateTapes();
  assert.equal(after.launchFor(ADDR).length, 1);
});

test('launch rows arrive oldest-first regardless of fetch order', async () => {
  disk = {};
  const feed = freshFeed();
  feed.noteLaunch(ADDR, [trade('newer', 10, '0xbb', false), trade('older', 300, '0xaa', true)]);
  assert.deepEqual(feed.launchFor(ADDR).map((r) => r.txHash), ['older', 'newer']);
});
