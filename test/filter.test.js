// Per-card safety readout (🛡 N/7, upgraded to N/9 with cached LP/renounce).
// Drives the real filter.scan() over a fake DOM with stubbed feed/creator/store:
// badge presence, verdict, colour class, hidden cards show none, in-place
// update without duplication, and the master toggle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const classSet = () => ({
  _s: new Set(),
  toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
  contains(c) { return this._s.has(c); },
  add(c) { this._s.add(c); }, remove(...cs) { cs.forEach((c) => this._s.delete(c)); }
});
const matches = (node, sel) =>
  sel.startsWith('.') && node.className && node.className.split(' ').includes(sel.slice(1));

const makeEl = (tag) => ({
  tag, className: '', textContent: '', title: '', href: '', type: '', id: '',
  style: {}, classList: classSet(), _children: [],
  append(...ns) { this._children.push(...ns); },
  appendChild(n) { this._children.push(n); return n; },
  querySelector(sel) { return this._children.find((c) => matches(c, sel)) || null; },
  querySelectorAll() { return []; },
  addEventListener() {}
});

const makeCard = ({ href, alts = [], titles = [], text = '' }) => {
  const el = makeEl('a');
  el._href = href; el.innerText = text;
  el.getAttribute = (a) => (a === 'href' ? el._href : null);
  el.querySelectorAll = (sel) => {
    if (sel === 'img') return alts.map((alt) => ({ alt }));
    if (sel === '[title]') return titles.map((t) => ({ getAttribute: () => t }));
    return [];
  };
  return el;
};

global.location = { pathname: '/pulse/robinhood', origin: 'https://basedbot.app' };
const registry = {};
let cards = [];
const feedRoot = { querySelectorAll: () => cards, contains: () => true };
global.document = {
  querySelector: (sel) => (sel === '.grid-cols-3' ? feedRoot : null),
  getElementById: (id) => registry[id] || null,
  createElement: (tag) => makeEl(tag),
  querySelectorAll: () => [],
  body: { appendChild: (n) => { if (n.id) registry[n.id] = n; return n; } }
};

// Hide rules OFF so the card-readout badge path runs (a hard hide would drop
// the card and hide its badge); score stubbed to 0 so gem/hot never interfere.
const SETTINGS = {
  filterEnabled: true, cardIntelEnabled: true, creatorGuardEnabled: true,
  auditGuardEnabled: true, hotEnabled: true, laptopHotAlerts: false,
  gemMinScore: 99, minScore: 2,
  hotMaxTop10: 30, hotMaxDev: 2, hotMaxSnipers: 15, hotMaxBundlers: 15,
  hotMaxInsiders: 20, hotMinHolders: 100, hotMinProRatio: 0.05, hotMaxProRatio: 0.6,
  hotMinUtilityScore: 2, memeKeywords: ['inu'],
  hide_top10_on: false, hide_insiders_on: false, hide_bundlers_on: false,
  hide_snipers_on: false, hide_dev_on: false
};
let STATSBY = {};
let INTEL = {};
global.BBD = {
  BAD_CREATOR_PENALTY: -3,
  AUDIT_DANGER_PENALTY: -5,
  HIDE_METRICS: [],
  isHeld: () => false,
  KEYS: { overrides: 'o', positions: 'p', intel: 'i' },
  UTILITY_TITLES: ['Website', 'GitHub'],
  sanitizeAlertText: (t) => t || '',
  tokenAddrFromHref: (h) => (h && h.match(/\/token\/[^/]+\/(0x[a-f0-9]+)/) || [])[1] || null,
  scoreCard: () => 0,
  statBonus: () => 0,
  hasMemeKeyword: (blob, kws) => kws.some((k) => blob.includes(k)),
  feed: {
    statsFor: (a) => STATSBY[a] || null, titlesFor: () => [],
    creatorFor: () => null, marketFor: () => null, auditFor: () => null
  },
  creator: { observe() {}, isFlagged: () => false },
  store: {
    async settings() { return SETTINGS; },
    async get(k, fb) { return k === 'i' ? INTEL : (fb || {}); },
    async mergeEntry() {}
  }
};

const load = (rel) => {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  src = src.replace(/const BBD = \{\};/, '');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
};
load('src/filter.js');
const F = BBD.filter;
const ci = (card) => card._children.find((c) => c.className.includes('bbd-cardintel'));

test('the per-card safety readout renders, updates and respects the toggle', async () => {
  const A = makeCard({ href: '/token/robinhood/0xaaa', titles: ['Website'], text: 'Clean Token' });
  const B = makeCard({ href: '/token/robinhood/0xbbb', titles: ['Website'], text: 'Risky Token' });
  const C = makeCard({ href: '/token/robinhood/0xccc', text: 'inu coin' }); // meme -> hidden
  const clean = { holders: 500, pro: 30, top10: 20, dev: 0, snipers: 2, bundlers: 1, insiders: 3, paid: true };
  const dirty = { holders: 50, pro: 5, top10: 90, dev: 50, snipers: 40, bundlers: 1, insiders: 3, paid: false };
  STATSBY = { '0xaaa': clean, '0xbbb': dirty, '0xccc': clean };
  INTEL = { '0xaaa': { lpBurned: 100, lpLocked: 0, renounced: true } }; // full 9-check verdict
  cards = [A, B, C];

  await F.scan();

  // clean + cached intel -> 9/9, green, shown
  assert.ok(ci(A), 'clean card has a readout badge');
  assert.equal(ci(A).textContent, '🛡 9/9');
  assert.ok(ci(A).className.includes('bbd-ci-good'));
  assert.equal(ci(A).style.display, 'block');
  assert.ok(!A.classList.contains('bbd-hidden'));

  // dirty -> fails Top10/Dev/Snipers/DexPaid/Holders = 5 fails -> 2/7, red
  assert.equal(ci(B).textContent, '🛡 2/7');
  assert.ok(ci(B).className.includes('bbd-ci-bad'));
  assert.match(ci(B).title, /Top10|Dev|Snipers/);

  // meme card hidden, no visible badge
  assert.ok(C.classList.contains('bbd-hidden'));
  assert.ok(!ci(C) || ci(C).style.display === 'none');

  // second scan updates in place, no duplicate badge
  STATSBY['0xbbb'] = clean;
  await F.scan();
  assert.equal(B._children.filter((c) => c.className.includes('bbd-cardintel')).length, 1);
  assert.equal(ci(B).textContent, '🛡 7/7');

  // disabling the readout hides the badge
  SETTINGS.cardIntelEnabled = false;
  await F.scan();
  assert.equal(ci(A).style.display, 'none');
});
