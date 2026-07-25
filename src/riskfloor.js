// A model can be argued out of a fact; a floor computed here cannot. Twice now
// a verdict has filed a hard exit hazard under "theoretical" and rated it away —
// an unsafe contract flag became MEDIUM, unburned LP became a point *against*
// the risk. So the facts that decide whether a position can be closed set a
// minimum level in code. The model may only raise the result, never undercut it.
'use strict';

BBD.riskFloor = (() => {
  const LEVELS = ['low', 'medium', 'high', 'critical'];

  const rank = (risk) => LEVELS.indexOf(typeof risk === 'string' ? risk : '');

  const read = (source, key) => {
    try {
      return source !== null && typeof source === 'object' ? source[key] : undefined;
    } catch (err) {
      return undefined;
    }
  };

  const finite = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  const setting = (settings, key, fallback) => {
    const value = finite(read(settings, key));
    return value !== null && value >= 0 ? value : fallback;
  };

  // Highest floor wins, so order here is presentation only.
  const evaluate = (snapshot, settings) => {
    try {
      const audit = read(snapshot, 'audit');
      const safety = read(snapshot, 'safety');
      const maxSellTax = setting(settings, 'scalpMaxSellTaxPct', 10);
      const lpPct = setting(settings, 'advisorFloorLpPct', 50);

      if (read(audit, 'danger') === true || read(audit, 'critical') === true) {
        return { level: 'high', reason: 'contract flagged unsafe by the audit' };
      }

      const sellTax = finite(read(safety, 'taxSell'));
      if (sellTax !== null && sellTax > maxSellTax) {
        return { level: 'high', reason: `sell tax ${sellTax}% blocks a clean exit` };
      }

      // Liquidity that is neither burned nor locked can be withdrawn at any
      // moment, which is the rug that actually fits inside a scalp window.
      // Unknown is not a floor: on a launchpad the panel often loads late, and
      // flooring every unread token would rebuild the "everything is high" noise.
      const burned = finite(read(safety, 'lpBurned'));
      const locked = finite(read(safety, 'lpLocked'));
      if ((burned !== null || locked !== null) &&
        !(burned !== null && burned >= lpPct) &&
        !(locked !== null && locked >= lpPct)) {
        return { level: 'medium', reason: 'LP is neither burned nor locked' };
      }

      return null;
    } catch (err) {
      return null;
    }
  };

  // Returns the verdict unchanged unless a floor outranks it. The original
  // level is kept so the card can show that the extension, not the model,
  // raised it — an unexplained bump would read as the model contradicting
  // its own reasons.
  const apply = (verdict, snapshot, settings) => {
    try {
      if (verdict === null || typeof verdict !== 'object') return verdict;
      if (read(settings, 'riskFloorEnabled') === false) return verdict;

      const floor = evaluate(snapshot, settings);
      if (!floor) return verdict;
      const floorRank = rank(floor.level);
      const current = rank(verdict.risk);
      if (floorRank < 0 || current >= floorRank) return verdict;

      return {
        ...verdict,
        risk: floor.level,
        raisedFrom: LEVELS[current] || 'unknown',
        raisedReason: floor.reason
      };
    } catch (err) {
      return verdict;
    }
  };

  return { LEVELS, evaluate, apply };
})();
