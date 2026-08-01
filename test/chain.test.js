// Canonical chain identity. BasedBot spells one chain up to four ways —
// /pulse/solana, /token/sol, the REST id -1, and Mobula's "solana:solana" —
// and every one of them must resolve to the same key, or the same token reads
// as two different positions depending on which surface reported it.
// See docs/solana-support.md §1.
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
load('src/chain.js');
const C = BBD.chain;

test('every spelling of Solana collapses to one key', () => {
  for (const v of ['solana', 'sol', 'SOL', -1, '-1', 'solana:solana']) {
    assert.equal(C.canonical(v), 'solana', `failed for ${v}`);
  }
});

test('the numeric id is the one the API accepts, never 0', () => {
  assert.equal(C.numericId('sol'), -1);
  assert.equal(C.numericId('solana'), -1);
  assert.equal(C.numericId('robinhood'), 4663);
  // An unverified chain yields null so no caller can invent an id the API
  // would reject outright.
  assert.equal(C.numericId('nonesuch'), null);
});

test('family comes from the chain, and falls back to the address format', () => {
  assert.equal(C.family('sol'), 'svm');
  assert.equal(C.family('robinhood'), 'evm');
  // Unknown chain: the address itself is decisive.
  assert.equal(C.family('newchain', '0xabcdef0123456789'), 'evm');
  assert.equal(C.family('newchain', 'So11111111111111111111111111111111111111112'), 'svm');
  assert.equal(C.family('newchain'), null);
});

test('isSame sees through the spellings, and stays false for real mismatches', () => {
  assert.equal(C.isSame('sol', 'solana'), true);
  assert.equal(C.isSame(-1, 'solana:solana'), true);
  assert.equal(C.isSame('base', 'ethereum'), false);
  assert.equal(C.isSame('sol', null), false);
});

test('an unknown chain keeps its own identity instead of collapsing', () => {
  assert.equal(C.canonical('somechain'), 'somechain');
  assert.equal(C.isSame('somechain', 'otherchain'), false);
  // Malformed input is rejected, not scrubbed into a plausible-looking chain.
  assert.equal(C.canonical('bad chain'), null);
});

test('both route shapes resolve, and they agree with each other', () => {
  assert.equal(C.fromPath('/pulse/solana'), 'solana');
  assert.equal(C.fromPath('/token/sol/So11111111111111111111111111111111111111112'), 'solana');
  assert.equal(C.fromPath('/pulse/robinhood'), 'robinhood');
  assert.equal(C.fromPath('/portfolio'), null);
});

test('capabilities separate "not on this chain" from "unknown"', () => {
  // EVM ownership renounce does not exist on Solana; SPL authorities do not
  // exist on EVM. Neither may be silently counted as a pass.
  assert.equal(C.supports('sol', 'renounced'), false);
  assert.equal(C.supports('robinhood', 'renounced'), true);
  assert.equal(C.supports('sol', 'freezeAuthority'), true);
  assert.equal(C.supports('robinhood', 'freezeAuthority'), false);
  assert.equal(C.supports('sol', 'hookAudit'), false);
  // Present on both, just sourced differently.
  assert.equal(C.supports('sol', 'tax'), true);
  assert.equal(C.supports('sol', 'lpBurnLock'), true);
  // An unidentifiable chain must not drop checks silently.
  assert.equal(C.supports('newchain', 'renounced'), true);
});

test('position identity survives the route/API spelling split', () => {
  const addr = 'So11111111111111111111111111111111111111112';
  const wallet = 'Wa11etTestAddress1111111111111111111111111111';
  // A position recorded from /token/sol/… and one from the -1 API are the
  // same position and must produce the same key.
  assert.equal(BBD.positionKey(addr, 'sol', wallet), BBD.positionKey(addr, 'solana', wallet));
  assert.equal(BBD.positionKey(addr, -1, wallet), BBD.positionKey(addr, 'solana', wallet));

  // ...and a stored "sol" position still matches a "solana" lookup.
  const key = BBD.positionKey(addr, 'sol', wallet);
  const pos = { addr, chain: 'sol' };
  assert.equal(BBD.positionIsToken(key, pos, addr, 'solana'), true);
  assert.equal(BBD.positionIsToken(key, pos, addr, -1), true);
  assert.equal(BBD.positionIsToken(key, pos, addr, 'base'), false);
});

test('a held Solana token is recognized regardless of which surface asked', () => {
  const addr = 'So11111111111111111111111111111111111111112';
  const positions = {
    [BBD.positionKey(addr, 'sol', 'w1')]: { addr, chain: 'sol', sourceTs: Date.now() }
  };
  assert.equal(BBD.isHeld(positions, addr, 'solana'), true);
  assert.equal(BBD.isHeld(positions, addr, 'sol'), true);
  assert.equal(BBD.isHeld(positions, addr, 'base'), false);
});

test('Dex Paid gates 🔥 on EVM but not on Solana', () => {
  // A DexScreener ad purchase is not a safety property. It separates tokens
  // someone spent money on from the rest only where it is common enough to
  // discriminate — measured on Solana at 1 of 300 Pulse tokens.
  assert.equal(C.supports('robinhood', 'dexPaidGate'), true);
  assert.equal(C.supports('base', 'dexPaidGate'), true);
  assert.equal(C.supports('sol', 'dexPaidGate'), false);
  assert.equal(C.supports('solana', 'dexPaidGate'), false);
  assert.equal(C.supports(-1, 'dexPaidGate'), false);
  // An unidentifiable chain keeps the stricter EVM behaviour.
  assert.equal(C.supports('newchain', 'dexPaidGate'), true);
});
