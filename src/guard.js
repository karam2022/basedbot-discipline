// Anti-FOMO guards backed by immutable journal history.
'use strict';

BBD.guard = (() => {
  const dayStr = () => BBD.localDayKey();
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

  const lossesToday = (journal) => {
    const t0 = startOfToday();
    return Object.values(BBD.journal.normalize(journal)).filter((e) =>
      e.status === 'closed' && typeof e.exitPct === 'number' && e.exitPct < 0 &&
      (e.closeTs || 0) >= t0).length;
  };

  const recentLoss = (entry, windowMin) => !!(entry && entry.status === 'closed' &&
    typeof entry.exitPct === 'number' && entry.exitPct < 0 &&
    Date.now() - (entry.closeTs || 0) < windowMin * 60 * 1000);

  const warningFor = (journal, positions, dismissed, addr, chain, settings) => {
    // Merely viewing a token after selling is not a revenge buy. Warn only when
    // the token is currently held again.
    const held = Object.entries(positions || {}).some(([key, p]) =>
      BBD.positionIsToken(key, p, addr, chain) &&
      typeof p.sourceTs === 'number' && Date.now() - p.sourceTs <= BBD.STALE_MS);
    if (!held) return null;
    const entry = BBD.journal.latestClosedFor(journal, addr, chain);
    if (!recentLoss(entry, settings.revengeWindowMin)) return null;
    if (dismissed && dismissed[entry.tradeId]) return null;
    return entry;
  };

  const hideOverlay = () => {
    const el = document.getElementById('bbd-fomo');
    if (el && el.style.display !== 'none') el.style.display = 'none';
  };

  const showOverlay = (losses, settings) => {
    let el = document.getElementById('bbd-fomo');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bbd-fomo';
      document.body.appendChild(el);
    }
    el.innerHTML = '';
    const msg = document.createElement('span');
    msg.className = 'bbd-fomo-msg';
    msg.textContent = `🛑 ${losses} losing trades today (limit ${settings.dailyLossLimit}). ` +
      'Step away — the market will still be here tomorrow.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Dismiss for today';
    btn.addEventListener('click', async () => {
      await BBD.store.mergeEntry(BBD.KEYS.daystats, 'lossDismissedDay', dayStr());
      hideOverlay();
    });
    el.append(msg, btn);
    el.style.display = 'flex';
  };

  const hideRevenge = () => {
    const el = document.getElementById('bbd-guard-revenge');
    if (el && el.style.display !== 'none') el.style.display = 'none';
  };

  const showRevenge = (entry) => {
    let el = document.getElementById('bbd-guard-revenge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bbd-guard-revenge';
      document.body.appendChild(el);
    }
    el.innerHTML = '';
    const mins = Math.max(1, Math.round((Date.now() - (entry.closeTs || 0)) / 60000));
    const sym = BBD.sanitizeAlertText(entry.symbol, 20) || 'this token';
    const msg = document.createElement('span');
    const pct = Math.round(entry.exitPct * 100) / 100;
    msg.textContent = `↩️ ${sym} was last tracked at ${pct}% before the position closed ${mins}m ago. ` +
      'Buying back — thesis, or FOMO?';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Dismiss';
    btn.title = 'Dismiss this warning';
    btn.addEventListener('click', async () => {
      await BBD.store.mergeEntry(BBD.KEYS.guardDismissed, entry.tradeId, Date.now());
      hideRevenge();
    });
    el.append(msg, btn);
    el.style.display = 'flex';
  };

  const tick = async () => {
    try {
      const settings = await BBD.store.settings();
      if (!settings.fomoGuardEnabled) {
        hideOverlay();
        hideRevenge();
        return;
      }
      const [journal, daystats, positions, dismissed] = await Promise.all([
        BBD.store.get(BBD.KEYS.journal, {}),
        BBD.store.get(BBD.KEYS.daystats, {}),
        BBD.store.get(BBD.KEYS.positions, {}),
        BBD.store.get(BBD.KEYS.guardDismissed, {})
      ]);
      const losses = lossesToday(journal);
      if (losses >= settings.dailyLossLimit && daystats.lossDismissedDay !== dayStr()) {
        showOverlay(losses, settings);
      } else {
        hideOverlay();
      }

      if (location.pathname.includes('/token/')) {
        const addr = BBD.tokenAddrFromHref(location.pathname);
        const chain = (location.pathname.match(/^\/token\/([^/]+)\//) || [])[1];
        const entry = addr && warningFor(journal, positions, dismissed, addr, chain, settings);
        if (entry) showRevenge(entry);
        else hideRevenge();
      } else {
        hideRevenge();
      }
    } catch (err) {
      console.warn('[bbd] guard tick failed', err);
    }
  };

  return { tick, lossesToday, recentLoss, warningFor };
})();
