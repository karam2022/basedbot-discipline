// Structure-break detector — "the first lower high after a climax", from the
// Trencher's Handbook, turned into a state machine so it fires without asking
// anyone's feelings at 3am. Per held position, on the PnL pct series the
// extension already samples:
//
//   RIDE      track the peak. Armed only after a real climax (peak >= arm%).
//   PULLBACK  price fell PULLBACK_PTS from the peak.
//   REBOUND   price rose REBOUND_PTS off the pullback low. If the rebound
//             exceeds the old peak, it was a healthy dip — back to RIDE.
//   FIRED     the rebound stalled at least LOWER_HIGH_PTS below the peak and
//             then rolled over ROLLOVER_PTS — a lower high, confirmed. Alert
//             once; re-arm only if a new all-time peak is made.
//
// Acting on the first clean signal instead of waiting for the stop-loss is the
// entire difference between clipping a winner and riding it back down.
'use strict';

BBD.structure = (() => {
  // Points are pct-points of PnL, matching the banner's own unit.
  const PULLBACK_PTS = 8;
  const REBOUND_PTS = 4;
  const LOWER_HIGH_PTS = 3;
  const ROLLOVER_PTS = 4;

  // Pure transition: (state, pct, armPct) -> { state, fired }. Exported for
  // tests; the module below just runs it over live positions.
  const step = (st, pct, armPct) => {
    const s = st ? { ...st } : { phase: 'ride', peak: pct };
    const prevPeak = s.peak; // the re-arm check must see the peak BEFORE this sample
    s.peak = Math.max(s.peak, pct);
    switch (s.phase) {
      case 'ride':
        if (s.peak >= armPct && pct <= s.peak - PULLBACK_PTS) {
          return { state: { ...s, phase: 'pullback', low: pct }, fired: false };
        }
        return { state: s, fired: false };
      case 'pullback':
        s.low = Math.min(s.low, pct);
        if (pct >= s.peak) return { state: { phase: 'ride', peak: pct }, fired: false };
        if (pct >= s.low + REBOUND_PTS) {
          return { state: { ...s, phase: 'rebound', rebHigh: pct }, fired: false };
        }
        return { state: s, fired: false };
      case 'rebound':
        s.rebHigh = Math.max(s.rebHigh, pct);
        if (s.rebHigh > s.peak - LOWER_HIGH_PTS) {
          // pushed back to (or through) the peak — not a lower high
          return { state: { phase: 'ride', peak: Math.max(s.peak, s.rebHigh) }, fired: false };
        }
        if (pct <= s.rebHigh - ROLLOVER_PTS) {
          return {
            state: { ...s, phase: 'fired', firedPeak: s.peak, firedAt: pct },
            fired: true
          };
        }
        return { state: s, fired: false };
      case 'fired':
        // stay quiet until a NEW peak re-arms the detector
        if (pct > prevPeak) return { state: { phase: 'ride', peak: pct }, fired: false };
        return { state: s, fired: false };
      default:
        return { state: { phase: 'ride', peak: pct }, fired: false };
    }
  };

  // key -> state machine; key -> pending alert. In-memory: a reload re-arms,
  // which errs toward re-warning — the right direction for a discipline tool.
  const machines = new Map();
  const pendingAlerts = new Map();

  // Feed the current positions through the machines; returns pending alerts
  // (unfiltered — the banner applies snooze/dismiss like any other row).
  const update = (positions, settings) => {
    const seen = new Set();
    for (const [positionKey, p] of Object.entries(positions || {})) {
      if (typeof p.pct !== 'number') continue;
      if (typeof p.sourceTs === 'number' && Date.now() - p.sourceTs > BBD.STALE_MS) continue;
      seen.add(positionKey);
      const r = step(machines.get(positionKey), p.pct, settings.structureArmPct);
      machines.set(positionKey, r.state);
      if (r.fired) {
        pendingAlerts.set(positionKey, {
          positionKey,
          actionKey: `sb:${positionKey}:${Math.round(r.state.firedPeak)}`,
          addr: BBD.positionAddr(positionKey, p),
          chain: p.chain, symbol: p.symbol,
          pct: p.pct, sourceTs: p.sourceTs,
          peakPct: Math.round(r.state.firedPeak),
          dismissMetric: p.pct
        });
      }
      // a fresh all-time peak voids the old warning
      const alert = pendingAlerts.get(positionKey);
      if (alert && p.pct > alert.peakPct) pendingAlerts.delete(positionKey);
      const live = pendingAlerts.get(positionKey);
      if (live) { live.pct = p.pct; live.sourceTs = p.sourceTs; }
    }
    // positions that left the wallet take their machines with them
    for (const key of [...machines.keys()]) {
      if (!seen.has(key)) { machines.delete(key); pendingAlerts.delete(key); }
    }
    return [...pendingAlerts.values()];
  };

  return { update, step };
})();
