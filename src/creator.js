// Creator reputation: tracks which addresses launched which tokens and how
// those tokens fared, so a serial launcher or a repeat rugger can be flagged
// on sight. creatorAddress comes from the metrics API (BBD.feed.creatorFor);
// the market cap/liquidity history comes from the feed list (BBD.feed.marketFor).
// This is the payoff of the API tap — a single Pulse card can never show that
// the same dev already rugged four tokens.
//
// The model is mutable and in-memory for speed (observe() runs per card, per
// scan) and hydrated from / flushed to storage. Rug status is NOT stored: it's
// recomputed from raw market history against current settings, so tightening a
// threshold reclassifies past tokens without a migration.
'use strict';

BBD.creator = (() => {
  let model = {};              // creatorAddr -> { tokens: { addr: {...} }, ts }
  const tokenCreator = new Map(); // addr -> creatorAddr (reverse index)
  let dirty = false;
  let hydrated = false;

  const rebuildIndex = () => {
    tokenCreator.clear();
    for (const [creatorAddr, c] of Object.entries(model)) {
      for (const addr of Object.keys(c.tokens || {})) tokenCreator.set(addr, creatorAddr);
    }
  };

  const hydrate = async () => {
    const stored = await BBD.store.get(BBD.KEYS.creators, {});
    if (stored && typeof stored === 'object') {
      model = stored;
      rebuildIndex();
    }
    hydrated = true;
  };

  // A token counts as a rug once it had a real market and then lost its
  // liquidity — the classic launch-pump-drain. Brand-new low-cap tokens can't
  // trip this (they never had the peak).
  const isRug = (t, settings) =>
    t.peakMcap >= settings.creatorRugMinPeakUsd &&
    typeof t.lastLiq === 'number' &&
    t.lastLiq < settings.creatorRugDeadLiqUsd;

  // Record (or update) one observation of a token by its creator. market may be
  // null — the launch still counts toward the serial-launcher tally.
  const observe = (tokenAddr, creatorAddr, market) => {
    if (!tokenAddr || !creatorAddr) return;
    const now = Date.now();
    const c = model[creatorAddr] || (model[creatorAddr] = { tokens: {}, ts: 0 });
    const t = c.tokens[tokenAddr] || (c.tokens[tokenAddr] = { firstTs: now });
    const before = JSON.stringify(t);
    t.lastTs = now;
    if (market) {
      if (market.symbol) t.symbol = market.symbol;
      if (typeof market.mcap === 'number') {
        t.lastMcap = market.mcap;
        t.peakMcap = Math.max(t.peakMcap || 0, market.mcap);
      }
      if (typeof market.liq === 'number') t.lastLiq = market.liq;
    }
    c.ts = now;
    tokenCreator.set(tokenAddr, creatorAddr);
    if (JSON.stringify(t) !== before) dirty = true;
  };

  const reputation = (creatorAddr, settings) => {
    const c = creatorAddr && model[creatorAddr];
    const tokens = c ? Object.values(c.tokens) : [];
    const ruggedCount = tokens.filter((t) => isRug(t, settings)).length;
    const launchCount = tokens.length;
    const flagged = settings.creatorGuardEnabled && (
      launchCount >= settings.creatorMaxLaunches ||
      ruggedCount >= settings.creatorMaxRugs
    );
    return { creatorAddr: creatorAddr || null, launchCount, ruggedCount, flagged };
  };

  // Full reputation for whichever creator launched tokenAddr. Resolves the
  // creator from the session's observations first, then the feed cache.
  const verdictFor = (tokenAddr, settings) => {
    const creatorAddr = tokenCreator.get(tokenAddr) || BBD.feed.creatorFor(tokenAddr);
    return reputation(creatorAddr, settings);
  };

  const isFlagged = (tokenAddr, settings) => verdictFor(tokenAddr, settings).flagged;

  // Merge our model over whatever another tab may have written since hydrate,
  // so concurrent tabs accumulate rather than clobber. Numeric fields combine
  // conservatively (min firstTs, max peak); the newest observation wins for the
  // rest.
  const mergeToken = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const newest = (b.lastTs || 0) >= (a.lastTs || 0) ? b : a;
    return {
      symbol: newest.symbol || a.symbol || b.symbol,
      firstTs: Math.min(a.firstTs || Infinity, b.firstTs || Infinity),
      lastTs: Math.max(a.lastTs || 0, b.lastTs || 0),
      peakMcap: Math.max(a.peakMcap || 0, b.peakMcap || 0),
      lastLiq: newest.lastLiq,
      lastMcap: newest.lastMcap
    };
  };
  const mergeModels = (a, b) => {
    const out = {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const ca = a[key];
      const cb = b[key];
      const tokens = {};
      const addrs = new Set([
        ...Object.keys(ca?.tokens || {}),
        ...Object.keys(cb?.tokens || {})
      ]);
      for (const addr of addrs) tokens[addr] = mergeToken(ca?.tokens?.[addr], cb?.tokens?.[addr]);
      out[key] = { tokens, ts: Math.max(ca?.ts || 0, cb?.ts || 0) };
    }
    return out;
  };

  const flush = async () => {
    if (!dirty || !hydrated || !BBD.alive()) return;
    dirty = false;
    const stored = await BBD.store.get(BBD.KEYS.creators, {});
    model = mergeModels(stored && typeof stored === 'object' ? stored : {}, model);
    rebuildIndex();
    await BBD.store.set(BBD.KEYS.creators, model);
  };

  hydrate();

  return { observe, verdictFor, isFlagged, reputation, flush };
})();
