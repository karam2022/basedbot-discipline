// The drag module is DOM glue, but its pure decisions — clamping a stored
// position into the viewport, gating on the setting, and handing a node back
// to its own positioner on reset — are worth pinning down.
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

global.BBD = global.BBD || {};
load('src/constants.js');

let disk = {};
let settings = { panelsDraggable: true };
BBD.alive = () => true;
BBD.store = {
  async get(key, fallback) {
    return disk[key] === undefined ? fallback : disk[key];
  },
  async set(key, value) {
    disk[key] = JSON.parse(JSON.stringify(value));
  },
  async settings() {
    return { ...BBD.DEFAULT_SETTINGS, ...settings };
  }
};

// A minimal element good enough for apply()/register()/reset().
const makeEl = (id, { w = 100, h = 40, rect = { left: 0, top: 0 } } = {}) => ({
  id,
  dataset: {},
  style: {},
  offsetWidth: w,
  offsetHeight: h,
  title: '',
  listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
  getBoundingClientRect() {
    // Mirror the real DOM: once left/top are set inline, the box reflects them.
    const left = this.style.left ? parseInt(this.style.left, 10) : rect.left;
    const top = this.style.top ? parseInt(this.style.top, 10) : rect.top;
    return { ...rect, left, top };
  }
});

global.window = { innerWidth: 1000, innerHeight: 800 };
// A document that records handlers so a drag gesture can be driven end to end.
const docHandlers = { pointermove: [], pointerup: [], click: [] };
global.document = {
  addEventListener(type, fn) { (docHandlers[type] || (docHandlers[type] = [])).push(fn); },
  removeEventListener(type, fn) {
    const list = docHandlers[type];
    if (list) docHandlers[type] = list.filter((f) => f !== fn);
  }
};
const fire = (type, event) => (docHandlers[type] || []).slice().forEach((fn) => fn(event));

const freshDrag = () => {
  delete BBD.drag;
  load('src/drag.js');
  return BBD.drag;
};

test('apply pins a stored position and clamps it into the viewport', async () => {
  disk = { panelPos: { 'bbd-price': { left: 300, top: 200 } } };
  const drag = freshDrag();
  await drag.hydrate();

  const el = makeEl('bbd-price');
  assert.equal(drag.isCustom('bbd-price'), true);
  assert.equal(drag.apply(el), true);
  assert.equal(el.style.left, '300px');
  assert.equal(el.style.top, '200px');
  // The auto-anchors are released so the stored top-left wins.
  assert.equal(el.style.right, 'auto');
  assert.equal(el.style.bottom, 'auto');

  // A position off the right edge is pulled back so it stays grabbable.
  disk = { panelPos: { 'bbd-price': { left: 5000, top: 5000 } } };
  const drag2 = freshDrag();
  await drag2.hydrate();
  const far = makeEl('bbd-price');
  drag2.apply(far);
  assert.equal(far.style.left, '900px'); // 1000 - 100
  assert.equal(far.style.top, '760px');  // 800 - 40
});

test('a node with no stored position is left to its own positioner', async () => {
  disk = {};
  const drag = freshDrag();
  await drag.hydrate();
  const el = makeEl('bbd-scalp');
  assert.equal(drag.isCustom('bbd-scalp'), false);
  assert.equal(drag.apply(el), false);
  assert.equal(el.style.left, undefined);
});

test('register wires a node once and reapplies its stored place', async () => {
  disk = { panelPos: { 'bbd-intel': { left: 50, top: 60 } } };
  const drag = freshDrag();
  await drag.hydrate();
  const el = makeEl('bbd-intel');
  drag.register(el);
  assert.equal(el.dataset.bbdDrag, '1');
  assert.equal(el.style.cursor, 'grab');
  assert.equal(el.style.pointerEvents, 'auto');
  assert.equal(el.style.left, '50px');
  assert.ok(typeof el.listeners.pointerdown === 'function');

  // A second register does not rewire, but still reapplies the position.
  el.style.left = '0px';
  drag.register(el);
  assert.equal(el.style.left, '50px');
});

test('register is a no-op when the setting is off', async () => {
  disk = {};
  settings = { panelsDraggable: false };
  const drag = freshDrag();
  await drag.hydrate();
  const el = makeEl('bbd-price');
  drag.register(el);
  assert.equal(el.dataset.bbdDrag, undefined);
  assert.equal(el.style.cursor, undefined);
  assert.equal(el.listeners.pointerdown, undefined);
  settings = { panelsDraggable: true };
});

test('reset clears the stored position and its inline styles', async () => {
  disk = { panelPos: { 'bbd-advisor': { left: 120, top: 130 } } };
  const drag = freshDrag();
  await drag.hydrate();
  const el = makeEl('bbd-advisor');
  drag.apply(el);
  assert.equal(el.style.left, '120px');

  drag.reset(el);
  assert.equal(drag.isCustom('bbd-advisor'), false);
  assert.equal(el.style.left, '');
  assert.equal(el.style.top, '');
  // The store no longer holds the reset node.
  assert.equal(disk.panelPos['bbd-advisor'], undefined);
});

test('a real drag stores the new position and swallows the release click', async () => {
  disk = {};
  settings = { panelsDraggable: true };
  const drag = freshDrag();
  await drag.hydrate();

  // A card whose grab landed on its button — the KI-check case.
  const el = makeEl('bbd-advisor', { rect: { left: 10, top: 10 } });
  drag.register(el);
  assert.equal(drag.isCustom('bbd-advisor'), false);

  el.listeners.pointerdown({ button: 0, clientX: 100, clientY: 100 });
  // A move past the threshold turns the press into a drag.
  fire('pointermove', { clientX: 160, clientY: 140, preventDefault() {} });
  assert.equal(el.style.left, '70px');  // 10 + (160-100)
  assert.equal(el.style.top, '50px');   // 10 + (140-100)

  let clickReached = false;
  fire('pointerup', {});
  // The drag registered a capturing click swallow; the button's click is eaten.
  fire('click', { stopPropagation() {}, preventDefault() { clickReached = true; } });
  assert.equal(clickReached, true, 'the release click was cancelled');
  assert.equal(drag.isCustom('bbd-advisor'), true);
  assert.deepEqual(disk.panelPos['bbd-advisor'], { left: 70, top: 50 });
});

test('a press without movement is a click, not a drag', async () => {
  disk = {};
  const drag = freshDrag();
  await drag.hydrate();
  const el = makeEl('bbd-price', { rect: { left: 10, top: 10 } });
  drag.register(el);

  el.listeners.pointerdown({ button: 0, clientX: 100, clientY: 100 });
  fire('pointermove', { clientX: 101, clientY: 101, preventDefault() {} }); // under threshold
  fire('pointerup', {});
  // Nothing moved and nothing was stored, so the click passes through normally.
  assert.equal(drag.isCustom('bbd-price'), false);
  let swallowed = false;
  fire('click', { stopPropagation() {}, preventDefault() { swallowed = true; } });
  assert.equal(swallowed, false);
});
