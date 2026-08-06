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

// ---- firehose admission: utility OR real volume, else dropped --------------
const UTILITY_TITLES = ['Website', 'GitHub', 'Docs', 'MCP', 'Discord', 'Medium', 'YouTube'];
const FIREHOSE_MIN_VOL_USD = 75000;
const moneyNum = (t) => { const m = (t||'').replace(/[$,]/g,'').match(/^([\d.]+)([KMB])?$/i); if(!m) return null;
  const u = { K:1e3, M:1e6, B:1e9 }[(m[2]||'').toUpperCase()] || 1; return Number(m[1])*u; };
const admit = (card, tier, hookWhy) => {
  const hasUtility = card.titles.some((t) => UTILITY_TITLES.includes(t));
  const bigVolume = (moneyNum(card.vol) || 0) >= FIREHOSE_MIN_VOL_USD;
  if (tier === 'band' && !hasUtility && !bigVolume && !hookWhy) return 'dropped';
  return 'firehose';
};
// the meme noise that made the channel 80% junk
assert.equal(admit({ titles: [], vol: '$12.0K' }, 'band', null), 'dropped');
assert.equal(admit({ titles: ['Telegram'], vol: '$3.0K' }, 'band', null), 'dropped');
// earns a slot on real turnover
assert.equal(admit({ titles: [], vol: '$230.9K' }, 'band', null), 'firehose');
// or on utility evidence
assert.equal(admit({ titles: ['Website'], vol: '$5.0K' }, 'band', null), 'firehose');
// or because its pitch is a hook mechanism
assert.equal(admit({ titles: [], vol: '$1.0K' }, 'band', 'site'), 'firehose');
// non-band tiers are already utility-gated upstream and always pass
assert.equal(admit({ titles: [], vol: '$0' }, 'fresh', null), 'firehose');
console.log('firehose admission: 6/6 ✓');

// ---- 💎 needs substance, not just clean stats ------------------------------
const GEM_MIN_AGE_MIN = 20, GEM_MIN_MC_USD = 40000, GEM_MIN_VOL_USD = 15000;
const NEW_MAX_AGE_MIN = 60;
const tierOf = ({ safe, kw, website, score, ageMin, mc, vol }) => {
  const substantial = ageMin !== null && ageMin >= GEM_MIN_AGE_MIN &&
    mc !== null && mc >= GEM_MIN_MC_USD && vol !== null && vol >= GEM_MIN_VOL_USD;
  if (safe && !kw && score >= 2 && substantial) return 'hot';
  if (safe && !kw && website && substantial) return 'gem';
  if (safe && !kw && website && !substantial && ageMin !== null && ageMin <= NEW_MAX_AGE_MIN) return 'fresh';
  return null;
};
// the exact shape of the bad call: clean stats, website, but 12 minutes old and tiny
assert.equal(tierOf({ safe: true, kw: false, website: true, score: 1, ageMin: 12, mc: 23000, vol: 49600 }), 'fresh',
  'a 12-minute-old $23K token is a NEW LISTING, never a gem');
// same token once it has actually survived and traded
assert.equal(tierOf({ safe: true, kw: false, website: true, score: 1, ageMin: 90, mc: 120000, vol: 60000 }), 'gem');
// substance without utility evidence is not promoted
assert.equal(tierOf({ safe: true, kw: false, website: false, score: 1, ageMin: 90, mc: 120000, vol: 60000 }), null);
// real turnover missing → not a gem even if old and mid-cap
assert.equal(tierOf({ safe: true, kw: false, website: true, score: 1, ageMin: 90, mc: 120000, vol: 200 }), null);
console.log('gem substance: 4/4 ✓');

// ---- radar: real account age, decoded from the X snowflake id --------------
const X_EPOCH_MS = 1288834974657n;
const createdMs = (id) => {
  const str = String(id || '');
  if (!/^\d+$/.test(str)) return null;
  if (str.length < 17) return 0;
  return Number((BigInt(str) >> 22n) + X_EPOCH_MS);
};
const ageDays = (id) => (Date.now() - createdMs(id)) / 86400000;
// a genuinely new account (klik_bot, created the day it surfaced)
assert.ok(ageDays('2085119518449565696') < 60, 'snowflake id decodes to a recent date');
// Cointelegraph-era ids predate snowflake entirely
assert.equal(createdMs('1333467482'), 0, 'short id = pre-snowflake = ancient');
assert.ok(ageDays('1333467482') > 5000, 'and therefore far outside the window');
assert.equal(createdMs('not-a-number'), null, 'unparseable ids are skipped, never guessed');
console.log('radar account age: 4/4 ✓');
