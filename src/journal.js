// Immutable trade journal. A token can be traded repeatedly; every open/close
// cycle gets its own trade id instead of overwriting the previous result.
'use strict';

BBD.journal = (() => {
  const asNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const addrOf = (id, entry) => entry.addr || BBD.positionAddr(entry.positionKey || id, entry);
  const keyOf = (id, entry) => entry.positionKey || BBD.positionKey(addrOf(id, entry), entry.chain, entry.wallet);

  // Upgrade address-keyed v1 entries in memory. The next journal write persists
  // the v2 shape, while read-only views can consume either schema immediately.
  const normalize = (journal) => {
    const out = {};
    for (const [legacyId, raw] of Object.entries(journal || {})) {
      if (!raw || typeof raw !== 'object') continue;
      const addr = addrOf(legacyId, raw);
      if (!addr) continue;
      const positionKey = keyOf(legacyId, raw);
      const baseTs = raw.openTs || raw.closeTs || 0;
      let tradeId = raw.tradeId || `legacy:${positionKey}:${baseTs}`;
      while (out[tradeId]) tradeId += ':dup';
      const migrated = { ...raw, tradeId, positionKey, addr };
      // v1 called the last observed unrealized value a realized exit without
      // recording sample age. Preserve it for reference, but do not let that
      // unverifiable value poison win-rate or revenge decisions after upgrade.
      if (!raw.tradeId && raw.status === 'closed' && typeof raw.exitPct === 'number') {
        migrated.exitEstimatePct = raw.exitPct;
        migrated.exitPct = null;
        migrated.exitEstimated = true;
        migrated.exitSampleAgeMs = null;
      }
      out[tradeId] = migrated;
    }
    return out;
  };

  const findOpen = (journal, positionKey, pos) => {
    const entries = Object.values(journal);
    const exact = entries.find((e) => e.status === 'open' && e.positionKey === positionKey);
    if (exact) return exact;
    // Migration fallback: attach a legacy address-only open to the new
    // chain/wallet-aware position instead of creating a duplicate.
    return entries.find((e) => e.status === 'open' && e.addr === pos.addr &&
      (!e.chain || !pos.chain || e.chain === pos.chain)) || null;
  };

  const uniqueTradeId = (journal, positionKey, ts) => {
    let id = `${positionKey}@${ts}`;
    let n = 1;
    while (journal[id]) id = `${positionKey}@${ts}-${n++}`;
    return id;
  };

  const entryVerdict = (pos, settings) => {
    const rep = BBD.creator && BBD.creator.verdictFor
      ? BBD.creator.verdictFor(pos.addr, settings) : null;
    const stats = BBD.feed && BBD.feed.statsFor ? BBD.feed.statsFor(pos.addr) : null;
    return {
      devFlagged: !!(rep && rep.flagged),
      devLaunches: rep ? rep.launchCount : 0,
      statsKnown: !!stats
    };
  };

  const createOpen = (journal, positionKey, pos, settings) => {
    const openTs = pos.sourceTs || Date.now();
    const tradeId = uniqueTradeId(journal, positionKey, openTs);
    journal[tradeId] = {
      tradeId,
      positionKey,
      addr: pos.addr,
      symbol: pos.symbol || pos.addr.slice(0, 6),
      chain: pos.chain || null,
      wallet: pos.wallet || null,
      openTs,
      lastSeenTs: pos.sourceTs || openTs,
      entryVerdict: entryVerdict(pos, settings),
      peakPct: pos.pct,
      lastPct: pos.pct,
      status: 'open'
    };
    return journal[tradeId];
  };

  const updateOpen = (entry, positionKey, pos) => ({
    ...entry,
    positionKey,
    addr: pos.addr,
    symbol: pos.symbol || entry.symbol,
    chain: pos.chain || entry.chain,
    wallet: pos.wallet || entry.wallet,
    peakPct: Math.max(asNumber(entry.peakPct) ?? pos.pct, pos.pct),
    lastPct: pos.pct,
    lastSeenTs: pos.sourceTs || Date.now()
  });

  const closeOpen = (entry, closeTs, settings) => {
    const lastSeenTs = entry.lastSeenTs || entry.openTs || 0;
    const sampleAgeMs = Math.max(0, closeTs - lastSeenTs);
    const lastPct = asNumber(entry.lastPct);
    const fresh = lastPct !== null && sampleAgeMs <= settings.exitSampleMaxAgeSec * 1000;
    return {
      ...entry,
      status: 'closed',
      closeTs,
      // This is an estimate from the last observed unrealized PnL, never
      // presented as an exact realized fill. Stale estimates cannot count as a
      // loss or trigger revenge mode (the SWOGE false-positive case).
      exitPct: fresh ? lastPct : null,
      exitEstimatePct: lastPct,
      exitEstimated: true,
      exitSampleAgeMs: sampleAgeMs
    };
  };

  // Pure reducer used by the balances reconciliation and regression tests.
  const reconcileState = (rawJournal, previous, next, settings, sourceTs, authoritative = true) => {
    const journal = normalize(rawJournal);
    const prev = previous || {};
    const upcoming = next || {};

    // Close positions that disappeared from the new authoritative snapshot.
    for (const [oldKey, oldPos] of Object.entries(prev)) {
      if (upcoming[oldKey]) continue;
      const oldAddr = BBD.positionAddr(oldKey, oldPos);
      const migratedKey = Object.entries(upcoming).find(([newKey, newPos]) =>
        BBD.positionIsToken(newKey, newPos, oldAddr, oldPos && oldPos.chain));
      if (migratedKey) continue;
      const open = findOpen(journal, oldKey, {
        ...oldPos,
        addr: oldAddr
      });
      if (open) journal[open.tradeId] = closeOpen(open, sourceTs, settings);
    }

    // Self-heal if a tab died after the worker committed positions but before
    // this journal write. Any v2 open absent from an authoritative snapshot is
    // closed; legacy wallet-less opens may migrate by matching token + chain.
    if (authoritative) {
      for (const entry of Object.values(journal).filter((e) => e.status === 'open')) {
        const exact = upcoming[entry.positionKey];
        const legacyMatch = !entry.wallet && Object.entries(upcoming).some(([key, p]) =>
          BBD.positionIsToken(key, p, entry.addr, entry.chain));
        if (!exact && !legacyMatch) {
          journal[entry.tradeId] = closeOpen(entry, sourceTs, settings);
        }
      }
    }

    if (!settings.journalEnabled) return journal;

    for (const [positionKey, rawPos] of Object.entries(upcoming)) {
      const pos = { ...rawPos, addr: BBD.positionAddr(positionKey, rawPos) };
      if (!pos.addr || asNumber(pos.pct) === null) continue;
      const open = findOpen(journal, positionKey, pos);
      if (open) {
        // A legacy entry may change ids/positionKey, but its immutable trade id
        // remains stable so dismissals and history links do not break.
        journal[open.tradeId] = updateOpen(open, positionKey, pos);
      } else {
        createOpen(journal, positionKey, pos, settings);
      }
    }
    return journal;
  };

  const reconcile = async (previous, next, sourceTs) => {
    const settings = await BBD.store.settings();
    const beforeMeta = await BBD.store.get(BBD.KEYS.positionsMeta, {});
    if (Number(beforeMeta.sourceTs) > Number(sourceTs)) return null;
    const current = await BBD.store.get(BBD.KEYS.journal, {});
    const updated = reconcileState(current, previous, next, settings, sourceTs || Date.now());
    const afterMeta = await BBD.store.get(BBD.KEYS.positionsMeta, {});
    if (Number(afterMeta.sourceTs) > Number(sourceTs)) return null;
    await BBD.store.set(BBD.KEYS.journal, updated);
    return updated;
  };

  // DOM fallback path for a single observed position.
  const onHeld = async (positionKey, pos) => {
    if (!positionKey || !pos || asNumber(pos.pct) === null) return;
    const settings = await BBD.store.settings();
    if (!settings.journalEnabled) return;
    const current = await BBD.store.get(BBD.KEYS.journal, {});
    const updated = reconcileState(current, {}, { [positionKey]: pos }, settings,
      pos.sourceTs || Date.now(), false);
    await BBD.store.set(BBD.KEYS.journal, updated);
  };

  const onClosed = async (positionKey, closeTs = Date.now()) => {
    if (!positionKey) return;
    const settings = await BBD.store.settings();
    const current = normalize(await BBD.store.get(BBD.KEYS.journal, {}));
    const targetAddr = BBD.positionAddr(positionKey, null);
    const open = Object.values(current).find((e) => e.status === 'open' &&
      (e.positionKey === positionKey || e.addr === targetAddr));
    if (!open) return;
    current[open.tradeId] = closeOpen(open, closeTs, settings);
    await BBD.store.set(BBD.KEYS.journal, current);
  };

  const latestClosedFor = (rawJournal, addr, chain) => Object.values(normalize(rawJournal))
    .filter((e) => e.status === 'closed' && e.addr === addr &&
      (!chain || !e.chain || String(e.chain).toLowerCase() === String(chain).toLowerCase()))
    .sort((a, b) => (b.closeTs || 0) - (a.closeTs || 0))[0] || null;

  const summarize = (rawJournal) => {
    const all = Object.values(normalize(rawJournal));
    const closed = all.filter((e) => e.status === 'closed' && asNumber(e.exitPct) !== null);
    const n = closed.length;
    const wins = closed.filter((e) => e.exitPct > 0).length;
    const gb = closed.filter((e) => asNumber(e.peakPct) !== null && e.peakPct > 0)
      .map((e) => e.peakPct - e.exitPct);
    const flagged = closed.filter((e) => e.entryVerdict && e.entryVerdict.devFlagged);
    const flaggedLosses = flagged.filter((e) => e.exitPct <= 0).length;
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
      openCount: all.filter((e) => e.status === 'open').length,
      closedCount: n,
      estimatedCount: closed.filter((e) => e.exitEstimated).length,
      unknownExitCount: all.filter((e) => e.status === 'closed' && asNumber(e.exitPct) === null).length,
      winRate: n ? Math.round((100 * wins) / n) : 0,
      avgExitPct: Math.round(mean(closed.map((e) => e.exitPct))),
      avgGiveBackPct: Math.round(mean(gb)),
      flaggedCount: flagged.length,
      flaggedLossRate: flagged.length ? Math.round((100 * flaggedLosses) / flagged.length) : 0
    };
  };

  return {
    normalize, reconcileState, reconcile, onHeld, onClosed, latestClosedFor, summarize
  };
})();
