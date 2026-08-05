// Pure-logic checks for the new gates, mirroring watcher.mjs definitions.
import assert from 'node:assert/strict';
const HOOK_NARRATIVE = /\b(uniswap\s*v4|v4\s*hook|hook[- ]?(powered|based|driven)|hooks?\b)/i;
const hookNarrative = (card, peekLine) => {
  const inName = HOOK_NARRATIVE.test(`${card.symbol || ''} ${card.name || ''}`);
  const inSite = Boolean(peekLine) && HOOK_NARRATIVE.test(peekLine);
  if (!inName && !inSite) return null;
  return inName ? 'name' : 'site';
};
// projects that SHOULD fire
assert.equal(hookNarrative({ symbol: 'HOOK', name: 'Hook' }, ''), 'name');
// "Hooked Protocol" is a real, unrelated BNB project — the word-boundary rule
// deliberately does NOT match it, and neither does "Car Hood". Substring
// matching here would flood quality with false hook narratives.
assert.equal(hookNarrative({ symbol: 'HOOKD', name: 'Hooked Protocol' }, ''), null);
assert.equal(hookNarrative({ symbol: 'SATO', name: 'Sato' },
  'SATO: minted through a Uniswap v4 Hook bonding curve'), 'site');
assert.equal(hookNarrative({ symbol: 'X', name: 'X' }, 'a v4 hook that mints NFTs on every swap'), 'site');
assert.equal(hookNarrative({ symbol: 'Y', name: 'Y' }, 'hook-powered liquidity engine'), 'site');
// and ones that should NOT
assert.equal(hookNarrative({ symbol: 'DOGE', name: 'Doge' }, 'the best dog coin'), null);
assert.equal(hookNarrative({ symbol: 'CARHOOD', name: 'Car Hood' }, 'cars'), null, 'substring must not match');
console.log('hook-narrative: 6/6 ✓');

// rehash guard
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const MAJORS = new Set(['bonk', 'jup', 'cake', 'pepe']);
const isRehash = (c) => MAJORS.has(norm(c.symbol)) || MAJORS.has(norm(c.name));
assert.equal(isRehash({ symbol: 'BONK', name: 'Bonk on RH' }), true);
assert.equal(isRehash({ symbol: 'CAKE' }), true);
assert.equal(isRehash({ symbol: 'GUSH', name: 'Gush' }), false);
console.log('rehash guard: 3/3 ✓');

// name-level dedupe
const NAME_DEDUPE_MS = 12 * 3600 * 1000;
const seen = { 'name:ele': { addr: '0xaaa', ts: Date.now() - 60000 } };
const blocked = (nkey, addr) => {
  const p = seen[`name:${nkey}`];
  return Boolean(p && p.addr !== addr && Date.now() - p.ts < NAME_DEDUPE_MS);
};
assert.equal(blocked('ele', '0xbbb'), true, 'same name, new address → blocked');
assert.equal(blocked('ele', '0xaaa'), false, 'same address → address-dedupe handles it');
assert.equal(blocked('gush', '0xccc'), false, 'unrelated name passes');
console.log('name dedupe: 3/3 ✓');

// chain tier policy
const CHAIN_TIERS = { robinhood: ['hot','gem','band','fresh','watch'], solana: ['hot','gem','fresh','watch'] };
assert.equal(CHAIN_TIERS.solana.includes('band'), false, 'no meme band lane on solana');
assert.equal(CHAIN_TIERS.robinhood.includes('band'), true);
console.log('chain policy: 2/2 ✓');
