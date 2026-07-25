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

  // Nearly every token on this launchpad has unburned LP, unrenounced
  // ownership and concentrated holders. Those are constants of the population,
  // not signals, and a level driven by them cannot discriminate between two
  // tokens — which is the whole job. So capability alone caps at medium, and
  // only an event actually visible in the data buys high or critical.
  const activeHazard = (snapshot, settings) => {
    const audit = read(snapshot, 'audit');
    const safety = read(snapshot, 'safety');
    const flow = read(snapshot, 'flow');
    const price = read(snapshot, 'price');

    if (read(audit, 'danger') === true || read(audit, 'critical') === true) {
      return 'the audit flags the contract';
    }
    const sellTax = finite(read(safety, 'taxSell'));
    if (sellTax !== null && sellTax > setting(settings, 'scalpMaxSellTaxPct', 10)) {
      return 'the sell tax blocks the exit';
    }
    if (read(flow, 'devSold') === true) return 'the creator is selling';

    const sniperNet = finite(read(flow, 'sniperNetUsd'));
    const sniperUsd = setting(settings, 'advisorActiveSniperUsd', 500);
    if (sniperNet !== null && sniperNet <= -sniperUsd) return 'snipers are dumping';

    // The real biggest holders selling now is a concrete exit event, not the
    // standing concentration every token carries.
    const holders = read(snapshot, 'holders');
    const topSelling = finite(read(holders, 'topHoldersSelling'));
    const topNet = finite(read(holders, 'topHoldersNetUsd'));
    if ((topSelling !== null && topSelling >= 2) ||
      (topNet !== null && topNet <= -sniperUsd)) {
      return 'top holders are selling';
    }

    const drop = finite(read(price, 'changePct5m'));
    const dropPct = setting(settings, 'exitAlarmDropPct', 8);
    if (drop !== null && drop <= -dropPct) return 'the price is already falling';

    return null;
  };

  const ceiling = (snapshot, settings) => {
    try {
      if (snapshot === null || typeof snapshot !== 'object') return null;
      // "Nothing is happening" is a claim about the tape, so it needs the tape.
      // Capping a snapshot whose flow and price never loaded would silently
      // downgrade a verdict on the strength of data we simply do not have.
      const seen = read(snapshot, 'flow') !== undefined ||
        read(snapshot, 'price') !== undefined;
      if (!seen) return null;
      if (activeHazard(snapshot, settings)) return null;
      return {
        level: 'medium',
        reason: 'no hazard is actually happening yet; unprotected LP and ' +
          'concentration are the baseline for every token here'
      };
    } catch (err) {
      return null;
    }
  };

  // Clamps the model between both bounds. The original level travels with the
  // verdict so the card can name the extension as the source — an unexplained
  // change would read as the model contradicting the reasons printed beneath.
  // The floor is applied last: a hazard it recognises is always an active
  // hazard too, so the two bounds can never fight over the same verdict.
  const apply = (verdict, snapshot, settings) => {
    try {
      if (verdict === null || typeof verdict !== 'object') return verdict;
      if (read(settings, 'riskFloorEnabled') === false) return verdict;

      const original = rank(verdict.risk);
      let level = original;
      let reason = null;
      let capped = false;

      const cap = ceiling(snapshot, settings);
      const capRank = cap ? rank(cap.level) : -1;
      if (capRank >= 0 && level > capRank) {
        level = capRank;
        reason = cap.reason;
        capped = true;
      }

      const floor = evaluate(snapshot, settings);
      const floorRank = floor ? rank(floor.level) : -1;
      if (floorRank >= 0 && level < floorRank) {
        level = floorRank;
        reason = floor.reason;
        capped = false;
      }

      if (level === original || !reason) return verdict;
      return {
        ...verdict,
        risk: LEVELS[level],
        [capped ? 'loweredFrom' : 'raisedFrom']: LEVELS[original] || 'unknown',
        [capped ? 'loweredReason' : 'raisedReason']: reason
      };
    } catch (err) {
      return verdict;
    }
  };

  return { LEVELS, evaluate, ceiling, apply };
})();
