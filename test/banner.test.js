// Peak-giveback banner: an open winner that hands back too many points from
// its observed peak gets its own "protect the win?" row. Drives the real
// banner.tick() with stubbed store + DOM; only the giveback path is enabled so
// no Chrome-notification channel is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const makeEl = () => {
  const cl = new Set();
  const node = {
    className: '', textContent: '', title: '', href: '', id: '', type: '',
    style: {}, _children: [],
    classList: { toggle: (c, on) => (on ? cl.add(c) : cl.delete(c)), contains: (c) => cl.has(c) },
    set innerHTML(v) { if (v === '') this._children = []; },
    append(...ns) { this._children.push(...ns); },
    appendChild(n) { this._children.push(n); return n; },
    addEventListener() {}
  };
  return node;
};

const registry = {};
global.document = {
  getElementById: (id) => registry[id] || null,
  createElement: () => makeEl(),
  body: { appendChild: (n) => { if (n.id) registry[n.id] = n; return n; } }
};

const STORE = { settings: {}, snoozes: {}, dismissed: {}, positions: {} };
global.BBD = {
  STALE_MS: 30 * 60 * 1000,
  KEYS: { snoozes: 'snoozes', dismissed: 'dismissed', positions: 'positions' },
  positionAddr: (key, p) => (p && p.addr) || key,
  sanitizeAlertText: (t) => t || '',
  store: {
    async settings() { return STORE.settings; },
    async get(k, fb) { return STORE[k] || fb; },
    async mergeEntry() {}
  }
};

const load = (rel) => {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  src = src.replace(/const BBD = \{\};/, '');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
};
load('src/banner.js');

const givebackRows = () => {
  const el = registry['bbd-banner'];
  if (!el || el.style.display === 'none') return []; // hide() leaves stale children in place
  return el._children.filter((c) => (c.className || '').includes('bbd-banner-row-giveback'));
};

test('a winner that gives back past the threshold raises one giveback row', async () => {
  const now = Date.now();
  STORE.settings = {
    reminderEnabled: false, stopLossEnabled: false, // isolate the giveback path
    peakGivebackEnabled: true, peakGivebackPct: 15, thresholdPct: 20,
    refireStepPct: 10, snoozeMin: 15
  };
  STORE.snoozes = {};
  STORE.dismissed = {};
  STORE.positions = {
    k1: { positionKey: 'k1', addr: '0xaaa', symbol: 'WIN', pct: 30, peakPct: 60, chain: 'robinhood', sourceTs: now },
    k2: { positionKey: 'k2', addr: '0xbbb', symbol: 'HOLD', pct: 55, peakPct: 60, chain: 'robinhood', sourceTs: now }
  };

  await BBD.banner.tick();

  const rows = givebackRows();
  assert.equal(rows.length, 1, 'only the position past the giveback threshold qualifies');
  const msg = rows[0]._children.find((c) => (c.className || '').includes('bbd-banner-msg'));
  assert.match(msg.textContent, /WIN/);
  assert.match(msg.textContent, /gave back 30 points/);
  assert.match(msg.textContent, /protect the win/i);
});

test('a stale position never nags, even past the threshold', async () => {
  const stale = Date.now() - (31 * 60 * 1000); // older than STALE_MS
  STORE.positions = {
    k1: { positionKey: 'k1', addr: '0xaaa', symbol: 'WIN', pct: 30, peakPct: 60, chain: 'robinhood', sourceTs: stale }
  };
  await BBD.banner.tick();
  assert.equal(givebackRows().length, 0);
});

test('a dismissed giveback stays quiet until it gives back another step', async () => {
  const now = Date.now();
  STORE.positions = {
    k1: { positionKey: 'k1', addr: '0xaaa', symbol: 'WIN', pct: 30, peakPct: 60, chain: 'robinhood', sourceTs: now }
  };
  STORE.dismissed = { 'peak:k1': 30 }; // dismissed at a 30-point giveback
  await BBD.banner.tick();
  assert.equal(givebackRows().length, 0, 'same giveback level stays dismissed');

  STORE.positions.k1.pct = 10; // giveback now 50 = +20 over the dismissed 30 (> refireStepPct)
  await BBD.banner.tick();
  assert.equal(givebackRows().length, 1, 're-fires after a further step of giveback');
});
