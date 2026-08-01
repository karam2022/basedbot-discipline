// Canonical chain identity. BasedBot names the same chain up to four different
// ways — the Pulse route says "solana", the token route says "sol", the REST
// API demands -1, and Mobula payloads carry "solana:solana". Comparing those
// as raw strings means a position opened on a token page never matches the same
// token seen from the feed. Everything that compares or keys by chain goes
// through here (see docs/solana-support.md §1).
'use strict';

BBD.chain = (() => {
  // Only chains whose slug AND numeric id were verified live are named here.
  // The numeric ids come from the API's own rejection message, which lists
  // every id it accepts; 0 is deliberately absent because it is not one of them.
  const CHAINS = Object.freeze([
    { key: 'solana', family: 'svm', id: -1, aliases: ['solana', 'sol', 'solana:solana'] },
    { key: 'robinhood', family: 'evm', id: 4663, aliases: ['robinhood'] },
    { key: 'ethereum', family: 'evm', id: 1, aliases: ['ethereum', 'eth'] },
    { key: 'base', family: 'evm', id: 8453, aliases: ['base'] },
    { key: 'bnb', family: 'evm', id: 56, aliases: ['bnb', 'bsc', 'binance'] },
    { key: 'arbitrum', family: 'evm', id: 42161, aliases: ['arbitrum', 'arb'] },
    { key: 'avalanche', family: 'evm', id: 43114, aliases: ['avalanche', 'avax'] },
    { key: 'unichain', family: 'evm', id: 130, aliases: ['unichain'] },
    { key: 'ink', family: 'evm', id: 57073, aliases: ['ink'] },
    { key: 'story', family: 'evm', id: 1514, aliases: ['story'] },
    { key: 'plasma', family: 'evm', id: 9745, aliases: ['plasma'] },
    { key: 'monad', family: 'evm', id: 143, aliases: ['monad'] },
    { key: 'abstract', family: 'evm', id: 2741, aliases: ['abstract'] }
  ]);

  const byAlias = new Map();
  const byKey = new Map();
  for (const entry of CHAINS) {
    byKey.set(entry.key, entry);
    for (const alias of entry.aliases) byAlias.set(alias, entry);
    byAlias.set(String(entry.id), entry);
  }

  // A raw chain value from any surface: route slug, numeric id (as number or
  // string), or a Mobula CAIP-style id. Unknown-but-well-formed values survive
  // as their own lowercased slug so a chain basedbot adds tomorrow still keys
  // and compares consistently instead of collapsing into "unknown".
  const clean = (value) => {
    if (typeof value !== 'string' && !Number.isFinite(value)) return null;
    const raw = String(value).trim().toLowerCase();
    return /^[a-z0-9:_-]{1,64}$/.test(raw) ? raw : null;
  };

  const entryFor = (value) => {
    const raw = clean(value);
    return raw === null ? null : byAlias.get(raw) || null;
  };

  // The stable key every comparison and storage key uses.
  const canonical = (value) => {
    const entry = entryFor(value);
    if (entry) return entry.key;
    const raw = clean(value);
    // Mobula's "namespace:reference" form degrades to its namespace, which is
    // the human-readable half ("solana:solana", "eip155:8453" -> "eip155").
    return raw === null ? null : (raw.includes(':') ? raw.split(':')[0] : raw);
  };

  // The numeric id the basedbot REST API demands. null when unverified — a
  // caller must not invent one, because the API rejects unknown ids outright.
  const numericId = (value) => {
    const entry = entryFor(value);
    return entry ? entry.id : null;
  };

  // 'evm' | 'svm' | null. Falls back to the address format, which is decisive
  // even for a chain this table has never heard of.
  const family = (value, addr) => {
    const entry = entryFor(value);
    if (entry) return entry.family;
    if (typeof addr === 'string' && addr) {
      if (addr.startsWith('0x')) return 'evm';
      if (/^[1-9A-HJ-NP-Za-km-z]{20,}$/.test(addr)) return 'svm';
    }
    return null;
  };

  const isSame = (a, b) => {
    const ca = canonical(a);
    const cb = canonical(b);
    return ca !== null && cb !== null && ca === cb;
  };

  // Capabilities that exist on one family and simply do not on the other.
  // "unknown" and "not applicable" must not read the same: a check the chain
  // cannot have should leave the denominator, not sit there as a silent pass.
  const CAPABILITIES = Object.freeze({
    // EVM ownership renounce. Solana has mint/freeze authority instead.
    renounced: { evm: true, svm: false },
    // Uniswap-v4 hooks — an EVM-only construct.
    hookAudit: { evm: true, svm: false },
    // SPL mint/freeze authority: the Solana equivalent of a honeypot switch.
    mintAuthority: { evm: false, svm: true },
    freezeAuthority: { evm: false, svm: true },
    // Present on both, just sourced differently (panel vs security API).
    tax: { evm: true, svm: true },
    lpBurnLock: { evm: true, svm: true },
    // "Dex Paid" is a DexScreener ad purchase, not a safety property. On the
    // EVM feeds it is common enough to separate tokens someone spent money on
    // from the rest. On Solana's launchpad population it is vanishingly rare —
    // measured 1 of 300 Pulse tokens — so requiring it would mean 🔥 never
    // fires there. It stays a scoring bonus on both chains; only the hard gate
    // is dropped (docs/solana-support.md §7).
    dexPaidGate: { evm: true, svm: false }
  });

  const supports = (value, capability, addr) => {
    const fam = family(value, addr);
    const row = CAPABILITIES[capability];
    if (!row) return false;
    // An unidentifiable chain must not silently drop checks: assume the
    // capability exists and let a null value mark it unknown instead.
    return fam === null ? true : Boolean(row[fam]);
  };

  // The chain of the page currently open, from either route shape.
  const fromPath = (pathname) => {
    if (typeof pathname !== 'string') return null;
    const m = pathname.match(/^\/(?:token|pulse)\/([^/]+)/);
    return m ? canonical(m[1]) : null;
  };

  const route = () => {
    try {
      return fromPath(location.pathname);
    } catch (err) {
      return null;
    }
  };

  return { canonical, numericId, family, isSame, supports, fromPath, route, CHAINS };
})();
