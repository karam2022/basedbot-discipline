// Marry the advisor's durable structural warning to the trade tape's live
// timing, so a fast drop can surface risk that neither signal proves alone.
'use strict';

BBD.exitAlarm = (() => {
  const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
  const COOLDOWN_MS = 15 * 60 * 1000;
  const alerted = new Map(); // addr -> last alert timestamp this session

  const values = (source) => {
    try {
      return source !== null && typeof source === 'object' ? Object.values(source) : [];
    } catch (err) {
      return [];
    }
  };

  // The journal owns the warning for the life of the position; the advisor's
  // short dedupe cache is intentionally irrelevant here.
  const riskFor = (rawJournal, positionKey) => {
    try {
      let journal = rawJournal;
      try {
        if (BBD.journal && typeof BBD.journal.normalize === 'function') {
          journal = BBD.journal.normalize(rawJournal);
        }
      } catch (err) {
        journal = rawJournal;
      }

      const entries = values(journal);
      let open = entries.find((entry) => entry && entry.status === 'open' &&
        entry.positionKey === positionKey);
      if (!open) {
        const addr = BBD.positionAddr(positionKey);
        open = entries.find((entry) => entry && entry.status === 'open' &&
          BBD.positionAddr(entry.positionKey, entry) === addr);
      }
      if (!open || !Array.isArray(open.advisorVerdicts)) return null;

      let highest = -1;
      for (const verdict of open.advisorVerdicts) {
        const severity = verdict && typeof verdict === 'object'
          ? RISK_LEVELS.indexOf(verdict.risk) : -1;
        if (severity > highest) highest = severity;
      }
      return highest >= 0 ? RISK_LEVELS[highest] : null;
    } catch (err) {
      return null;
    }
  };

  const decide = (input) => {
    try {
      const { risk, changePct5m, dropThresholdPct } =
        input !== null && typeof input === 'object' ? input : {};
      return (risk === 'high' || risk === 'critical') &&
        typeof changePct5m === 'number' && Number.isFinite(changePct5m) &&
        typeof dropThresholdPct === 'number' && Number.isFinite(dropThresholdPct) &&
        dropThresholdPct > 0 && changePct5m <= -dropThresholdPct;
    } catch (err) {
      return false;
    }
  };

  const check = async (pos, trades, settings) => {
    try {
      if (!BBD.alive() || !settings.exitAlarmEnabled) return;
      const now = Date.now();
      const candles = BBD.candles.build(trades, { bucketMs: 60 * 1000, now });
      const { changePct5m } = BBD.candles.priceChanges(candles, { now });
      const journal = await BBD.store.get(BBD.KEYS.journal, {});
      const risk = riskFor(journal, pos.positionKey);
      if (!decide({
        risk,
        changePct5m,
        dropThresholdPct: settings.exitAlarmDropPct
      })) return;

      const lastAlert = alerted.get(pos.addr);
      if (typeof lastAlert === 'number' && now - lastAlert < COOLDOWN_MS) return;
      alerted.set(pos.addr, now);

      const sym = BBD.sanitizeAlertText(pos.symbol, 20) || pos.addr.slice(0, 8);
      try {
        chrome.runtime.sendMessage({
          type: 'bbd-notify',
          dedupe: { key: `exit:${pos.chain || 'unknown'}:${pos.addr}` },
          title: `⚠️ ${sym}: AI-flagged risk is moving`,
          message: `The advisor rated ${sym} ${risk.toUpperCase()}; price is down ${Math.abs(Math.round(changePct5m))}% in 5m — the structural risk it flagged may be materializing.`,
          url: pos.chain ? `${location.origin}/token/${pos.chain}/${pos.addr}` : undefined
        });
      } catch (err) {
        console.warn('[bbd] exit alarm failed', err);
      }
    } catch (err) {
      console.warn('[bbd] exit alarm check failed', err);
    }
  };

  return { check, decide, riskFor };
})();
