// Paper-trading harness. ZERO money, ZERO wallet, ZERO execution — it only
// logs the trades the discipline strategy WOULD make against live feed prices,
// so we can answer the one question that matters before risking a cent: does
// the machine beat zero? Honesty features that make paper results trustworthy:
//   - marks on live feed MC (verified to move; metadata price_native did not)
//   - round-trip slippage haircut (buy higher, sell lower) — the #1 reason
//     naive paper traders look profitable and lose money live
//   - every mark records its source (feed / meta / stale); the report states
//     what fraction of exits were on live prices
//   - a holder-bleed kill-switch stands in for the live bot's dev-sell/LP
//     exits (paper v1 has no trade-feed access per position)
'use strict';

// Pure strategy core — no I/O, fully testable. Given a position and a current
// mark, returns the fills to apply and whether the position closes.
export const DEFAULTS = {
  paperEnabled: true,
  paperMaxConcurrent: 4,
  paperEntryUsd: 12,
  paperSlippagePct: 3,       // applied on entry (buy higher) AND each exit (sell lower)
  paperStopLossPct: -22,
  paperTimeStopMin: 90,
  paperTrailArmPct: 50,      // arm the runner's trailing stop after +50%
  paperTrailDropPct: 25,     // sell the runner if it falls this far from peak
  paperKillHolderDropPct: 15, // holders bleeding this far from peak → market-sell
  // ladder: sell frac at +at%. The unallocated remainder (0.1) is the runner.
  paperLadder: [{ at: 30, frac: 0.4 }, { at: 100, frac: 0.3 }, { at: 300, frac: 0.2 }]
};

// Decide fills for one mark. Pure: (position, mark, settings) -> {fills, close, reason}.
// `mark` = { mc, holdersDropPct, ageMin, source }.
export const evaluate = (pos, mark, s) => {
  const fills = [];
  const slip = s.paperSlippagePct / 100;
  const effEntry = pos.entryMc * (1 + slip);           // we bought a bit high
  const sellPrice = mark.mc * (1 - slip);              // we sell a bit low
  const pct = (mark.mc / pos.entryMc - 1) * 100;
  const peakMc = Math.max(pos.peakMc || pos.entryMc, mark.mc);
  const peakPct = (peakMc / pos.entryMc - 1) * 100;
  const sellAll = (reason) => {
    if (pos.remaining > 1e-6) fills.push({ frac: pos.remaining, sellPrice, reason });
  };

  // 1. kill-switch: structure deteriorating → dump the whole bag
  if (typeof mark.holdersDropPct === 'number' && mark.holdersDropPct >= s.paperKillHolderDropPct) {
    sellAll(`kill: holders −${Math.round(mark.holdersDropPct)}%`);
    return { fills, close: true, effEntry };
  }
  // 2. hard stop-loss
  if (pct <= s.paperStopLossPct) {
    sellAll(`stop-loss ${Math.round(pct)}%`);
    return { fills, close: true, effEntry };
  }
  // 3. ladder tranches (fill any un-filled rung the price has reached)
  for (const t of pos.tranches) {
    if (!t.filled && pct >= t.at) {
      t.filled = true;
      fills.push({ frac: t.frac, sellPrice, reason: `TP +${t.at}%` });
    }
  }
  const remainingAfter = pos.remaining - fills.reduce((a, f) => a + f.frac, 0);
  // 4. trailing stop on the runner (only once armed, and only if a runner is left)
  if (remainingAfter > 1e-6 && peakPct >= s.paperTrailArmPct &&
    pct <= peakPct - s.paperTrailDropPct) {
    fills.push({ frac: remainingAfter, sellPrice, reason: `trailing −${s.paperTrailDropPct}% from +${Math.round(peakPct)}%` });
    return { fills, close: true, effEntry, peakMc };
  }
  // 5. time stop: dead money after the window → recycle capital
  if (mark.ageMin >= s.paperTimeStopMin && Math.abs(pct) < 15 && remainingAfter > 1e-6) {
    fills.push({ frac: remainingAfter, sellPrice, reason: `time-stop ${Math.round(pct)}% @ ${Math.round(mark.ageMin)}min` });
    return { fills, close: true, effEntry, peakMc };
  }
  const close = remainingAfter <= 1e-6;
  return { fills, close, effEntry, peakMc };
};

// Position return so far (sum of fills, each frac × its realized return vs
// effective entry). Complete once fracs sum to 1.
export const positionReturnPct = (pos) =>
  pos.fillLog.reduce((acc, f) => acc + f.frac * ((f.sellPrice / pos.effEntry - 1) * 100), 0);

export const summarize = (trades) => {
  if (!trades.length) return { trades: 0 };
  const rets = trades.map((t) => t.returnPct);
  const wins = rets.filter((r) => r > 0).length;
  const sorted = [...rets].sort((a, b) => a - b);
  const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const liveMarks = trades.reduce((a, t) => a + (t.marksLive || 0), 0);
  const totalMarks = trades.reduce((a, t) => a + (t.marksLive || 0) + (t.marksStale || 0), 0);
  return {
    trades: trades.length,
    winRatePct: Math.round((wins / trades.length) * 100),
    avgReturnPct: +avg.toFixed(1),
    medianReturnPct: +median.toFixed(1),
    bestPct: +Math.max(...rets).toFixed(0),
    worstPct: +Math.min(...rets).toFixed(0),
    avgHoldMin: Math.round(trades.reduce((a, t) => a + (t.holdMin || 0), 0) / trades.length),
    liveMarkPct: totalMarks ? Math.round((liveMarks / totalMarks) * 100) : 0,
    beatsZero: avg > 0
  };
};

// ---- stateful trader over the pure core (I/O injected for testability) -----
export const createPaperTrader = ({ loadJson, saveJson, appendLine, readTrades, posPath, logPath, settings }) => {
  const S = { ...DEFAULTS, ...(settings || {}) };
  let positions = loadJson(posPath, {}); // addr -> position

  const isOpen = (addr) => Boolean(positions[addr]);
  const openCount = () => Object.keys(positions).length;

  const open = (addr, chain, symbol, entryMc, entryStats) => {
    if (!S.paperEnabled || isOpen(addr)) return null;
    if (openCount() >= S.paperMaxConcurrent) return { skipped: 'max-concurrent' };
    if (!(entryMc > 0)) return { skipped: 'no-entry-price' };
    const allocated = S.paperLadder.reduce((a, t) => a + t.frac, 0);
    positions[addr] = {
      addr, chain, symbol, entryMc, entryTs: Date.now(),
      entryStats: entryStats || null,
      peakMc: entryMc, remaining: 1,
      effEntry: entryMc * (1 + S.paperSlippagePct / 100),
      tranches: S.paperLadder.map((t) => ({ ...t, filled: false })),
      runnerFrac: Math.max(0, +(1 - allocated).toFixed(4)),
      fillLog: [], entryHolders: entryStats && entryStats.holders, peakHolders: entryStats && entryStats.holders,
      marksLive: 0, marksStale: 0
    };
    saveJson(posPath, positions);
    return { opened: true, symbol, entryMc };
  };

  // marks: { [addr]: { mc, holders, source } }. Applies the strategy, closes
  // finished positions, appends closed trades to the log.
  const mark = (marks) => {
    const closed = [];
    for (const [addr, pos] of Object.entries(positions)) {
      const m = marks[addr];
      if (!m || !(m.mc > 0)) { pos.marksStale = (pos.marksStale || 0) + 1; continue; }
      if (m.source === 'feed') pos.marksLive = (pos.marksLive || 0) + 1;
      else pos.marksStale = (pos.marksStale || 0) + 1;
      if (typeof m.holders === 'number') pos.peakHolders = Math.max(pos.peakHolders || 0, m.holders);
      const holdersDropPct = (pos.peakHolders > 0 && typeof m.holders === 'number')
        ? (1 - m.holders / pos.peakHolders) * 100 : null;
      const ageMin = (Date.now() - pos.entryTs) / 60000;
      const res = evaluate(pos, { mc: m.mc, holdersDropPct, ageMin, source: m.source }, S);
      pos.peakMc = res.peakMc || Math.max(pos.peakMc, m.mc);
      for (const f of res.fills) {
        pos.remaining = +(pos.remaining - f.frac).toFixed(6);
        pos.fillLog.push(f);
      }
      if (res.close || pos.remaining <= 1e-6) {
        const returnPct = +positionReturnPct(pos).toFixed(1);
        const trade = {
          addr, symbol: pos.symbol, chain: pos.chain,
          entryTs: pos.entryTs, closeTs: Date.now(),
          holdMin: Math.round((Date.now() - pos.entryTs) / 60000),
          returnPct,
          exits: pos.fillLog.map((f) => f.reason),
          entryStats: pos.entryStats,
          marksLive: pos.marksLive, marksStale: pos.marksStale
        };
        appendLine(logPath, JSON.stringify(trade));
        closed.push(trade);
        delete positions[addr];
      }
    }
    saveJson(posPath, positions);
    return closed;
  };

  const report = () => ({
    open: Object.values(positions),
    summary: summarize(readTrades ? readTrades(logPath) : [])
  });

  return { open, mark, isOpen, openCount, positions: () => positions, report, S };
};
