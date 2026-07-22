// Trade journal: records each position's lifecycle so the popup can hold up a
// mirror — win rate, average realized PnL, and how much peak profit was given
// back (the discipline metric: winners ridden past the exit). Entry captures a
// safety snapshot (creator-flag + whether stats were known) so you can later
// see e.g. "the tokens I bought from flagged devs lost 80% of the time".
//
// Driven by pnl.js: onHeld() on every observation of a held position, onClosed()
// when the position goes to zero. Entry fields are snapshotted once at open and
// never overwritten; peak/last track the ride.
'use strict';

BBD.journal = (() => {
  const onHeld = async (addr, { symbol, chain, pct }) => {
    if (!addr || typeof pct !== 'number' || Number.isNaN(pct)) return;
    const settings = await BBD.store.settings();
    if (!settings.journalEnabled) return;
    const j = await BBD.store.get(BBD.KEYS.journal, {});
    const cur = j[addr];
    if (!cur || cur.status === 'closed') {
      // New open — snapshot the safety verdict as it stands at entry.
      const rep = BBD.creator && BBD.creator.verdictFor
        ? BBD.creator.verdictFor(addr, settings) : null;
      const stats = BBD.feed && BBD.feed.statsFor ? BBD.feed.statsFor(addr) : null;
      await BBD.store.mergeEntry(BBD.KEYS.journal, addr, {
        symbol: symbol || addr.slice(0, 6),
        chain: chain || null,
        openTs: Date.now(),
        entryVerdict: {
          devFlagged: !!(rep && rep.flagged),
          devLaunches: rep ? rep.launchCount : 0,
          statsKnown: !!stats
        },
        peakPct: pct,
        lastPct: pct,
        status: 'open'
      });
      return;
    }
    // Existing open — extend the ride (peak climbs, last tracks current).
    const peakPct = Math.max(typeof cur.peakPct === 'number' ? cur.peakPct : pct, pct);
    if (peakPct !== cur.peakPct || pct !== cur.lastPct || symbol && symbol !== cur.symbol) {
      await BBD.store.mergeEntry(BBD.KEYS.journal, addr, {
        ...cur, symbol: symbol || cur.symbol, chain: chain || cur.chain, peakPct, lastPct: pct
      });
    }
  };

  const onClosed = async (addr) => {
    if (!addr) return;
    const settings = await BBD.store.settings();
    if (!settings.journalEnabled) return;
    const j = await BBD.store.get(BBD.KEYS.journal, {});
    const cur = j[addr];
    if (!cur || cur.status === 'closed') return;
    await BBD.store.mergeEntry(BBD.KEYS.journal, addr, {
      ...cur, status: 'closed', closeTs: Date.now(), exitPct: cur.lastPct
    });
  };

  // Aggregate closed trades. avgGiveBack = mean(peak − exit) over trades that
  // were ever green — the profit handed back by not taking it.
  const summarize = (journal) => {
    const all = Object.values(journal || {});
    const closed = all.filter((e) => e.status === 'closed' && typeof e.exitPct === 'number');
    const n = closed.length;
    const wins = closed.filter((e) => e.exitPct > 0).length;
    const gb = closed
      .filter((e) => typeof e.peakPct === 'number' && e.peakPct > 0)
      .map((e) => e.peakPct - e.exitPct);
    const flagged = closed.filter((e) => e.entryVerdict && e.entryVerdict.devFlagged);
    const flaggedLosses = flagged.filter((e) => e.exitPct <= 0).length;
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
      openCount: all.filter((e) => e.status === 'open').length,
      closedCount: n,
      winRate: n ? Math.round((100 * wins) / n) : 0,
      avgExitPct: Math.round(mean(closed.map((e) => e.exitPct))),
      avgGiveBackPct: Math.round(mean(gb)),
      flaggedCount: flagged.length,
      flaggedLossRate: flagged.length ? Math.round((100 * flaggedLosses) / flagged.length) : 0
    };
  };

  return { onHeld, onClosed, summarize };
})();
