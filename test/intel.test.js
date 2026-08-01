// The 🛡 token-page verdict chip. The panel labels are identical on Robinhood
// and Solana, but two of the checks do not exist on Solana (Renounced is always
// "—", there is no Tax row) and two exist only there (the SPL mint/freeze
// authorities, which come from api/2/token/security, not from the panel).
// Panel text captured live 2026-08-01 — see docs/solana-support.md §4.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// The panel renders each value BEFORE its label.
const PANEL = [
  'Token Info',
  '15%', 'Top 10 H.',
  '1%', 'Dev H.',
  '0%', 'Snipers H.',
  '0%', 'Insiders',
  '0%', 'Bundlers',
  '—', 'Renounced',
  '100%', 'LP Burned',
  '0%', 'LP Locked',
  '0.0%', 'Token Burn',
  '150', 'Holders',
  '20', 'Pro Traders',
  'Unpaid', 'Dex Paid',
  '0.080', 'Fees Paid'
];

let panelText = PANEL.join('\n');
const registry = {};
const makeEl = () => ({
  id: '', className: '', textContent: '', style: {}, isConnected: true,
  appendChild(n) { return n; }
});

global.document = {
  get body() { return { innerText: panelText, appendChild: (n) => { if (n.id) registry[n.id] = n; return n; } }; },
  getElementById: (id) => registry[id] || null,
  createElement: () => makeEl(),
  querySelectorAll: () => []
};
global.location = { pathname: '/token/robinhood/0xaaa', origin: 'https://basedbot.app' };

const SETTINGS = {
  hotMaxTop10: 30, hotMaxDev: 2, hotMaxSnipers: 15, hotMaxBundlers: 15,
  hotMaxInsiders: 20, hotMinHolders: 100, maxTaxPct: 10,
  creatorGuardEnabled: false, auditGuardEnabled: false
};

let SECURITY = null;
global.BBD = {
  KEYS: { intel: 'i' },
  tokenAddrFromHref: (h) => (h && h.match(/\/token\/[^/]+\/(\S+)/) || [])[1] || null,
  feed: { securityFor: () => SECURITY, creatorFor: () => null, marketFor: () => null, auditFor: () => null },
  creator: { observe() {}, verdictFor: () => null },
  store: { async settings() { return SETTINGS; }, async mergeEntry() {} }
};

const load = (rel) => {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  src = src.replace(/const BBD = \{\};/, '');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
};
load('src/chain.js');
load('src/intel.js');

// Set explicitly per test: a test that mutated shared panel state and restored
// it at the end would leak into every following test the moment it failed.
const setPanel = ({ paid = false } = {}) => {
  panelText = PANEL.map((l) => (l === 'Unpaid' && paid ? 'Paid' : l)).join('\n');
};

const chipText = async () => {
  await BBD.intel.scan();
  return registry['bbd-intel'].textContent;
};
// "🛡 7/9 checks · ⚠️ …" -> [7, 9]
const score = (text) => (text.match(/(\d+)\/(\d+) checks/) || []).slice(1).map(Number);

test('on Robinhood the EVM checks run and the SPL ones do not exist', async () => {
  global.location.pathname = '/token/robinhood/0xaaa';
  setPanel();
  SECURITY = null;
  const text = await chipText();
  // Renounced is "—" here too (unknown), and there is no Tax row in this
  // fixture, so both drop out of the denominator: 8 of the 10 EVM checks.
  const [passed, total] = score(text);
  assert.equal(total, 8);
  assert.equal(passed, 7); // everything but Dex Paid
  assert.match(text, /Dex Paid/);
  assert.equal(/Mint revoked|Freeze revoked/.test(text), false);
});

test('on Solana Dex Paid stops failing and the SPL authorities appear', async () => {
  global.location.pathname = '/token/sol/So11111111111111111111111111111111111111112';
  setPanel();
  SECURITY = { buyTax: 0, sellTax: 0, top10: null, mintable: false, freezable: false };
  const text = await chipText();
  const [passed, total] = score(text);
  // Dropped: Renounced (no such thing on Solana) and Dex Paid (Unpaid is
  // uninformative there). Added: Mint revoked, Freeze revoked. Tax now comes
  // from the security block, which the panel never shows — so the denominator
  // goes UP on Solana, from 8 to 10.
  assert.equal(total, 10);
  assert.equal(passed, 10);
  assert.match(text, /clean/);
  assert.equal(/Dex Paid/.test(text), false);
});

test('an active freeze authority fails the chip, not just the audit', async () => {
  global.location.pathname = '/token/sol/So11111111111111111111111111111111111111112';
  setPanel();
  SECURITY = { buyTax: 0, sellTax: 0, top10: null, mintable: false, freezable: true };
  const text = await chipText();
  assert.match(text, /Freeze revoked/);
  const [passed, total] = score(text);
  assert.equal(total, 10);
  assert.equal(passed, 9);
});

test('a paid Solana token still earns the Dex Paid pass', async () => {
  global.location.pathname = '/token/sol/So11111111111111111111111111111111111111112';
  setPanel({ paid: true });
  SECURITY = { buyTax: 0, sellTax: 0, top10: null, mintable: false, freezable: false };
  const text = await chipText();
  const [passed, total] = score(text);
  // The denominator going 10 -> 11 is the proof that Dex Paid re-entered the
  // count; a passing check is never named in the chip text, only failures are.
  assert.equal(total, 11);
  assert.equal(passed, 11);
  assert.match(text, /clean/);
});

test('the security block fills the tax the Solana panel never renders', async () => {
  global.location.pathname = '/token/sol/So11111111111111111111111111111111111111112';
  setPanel();
  SECURITY = { buyTax: 0, sellTax: 25, top10: null, mintable: false, freezable: false };
  const text = await chipText();
  // A 25% sell tax is over maxTaxPct and must show as a failure even though
  // the token page has no Tax row at all.
  assert.match(text, /Tax ≤10%/);
  const [passed, total] = score(text);
  assert.equal(total, 10);
  assert.equal(passed, 9);
});

test('without a security block the SPL checks stay unknown, not passed', async () => {
  global.location.pathname = '/token/sol/So11111111111111111111111111111111111111112';
  setPanel();
  SECURITY = null;
  const text = await chipText();
  const [, total] = score(text);
  // Only the panel's own checks remain: neither authority may count as revoked
  // just because nobody has reported on it yet.
  assert.equal(total, 7);
  assert.equal(/Mint revoked|Freeze revoked/.test(text), false);
});
