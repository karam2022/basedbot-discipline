// Anti-FOMO guards, driven entirely by the trade journal (no new scraping):
//  - Daily loss limit: once you've closed N losing trades today, a "step away"
//    overlay appears on every page until dismissed for the day.
//  - Revenge trade: opening a token you closed at a loss within the last hour
//    raises a warning on that token's page.
// Both read the journal the same way the popup summary does; the pure logic
// (lossesToday / recentLoss) is exposed for testing.
'use strict';

BBD.guard = (() => {
  const dayStr = () => new Date().toISOString().slice(0, 10);
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

  const lossesToday = (journal) => {
    const t0 = startOfToday();
    return Object.values(journal || {}).filter((e) =>
      e.status === 'closed' && typeof e.exitPct === 'number' && e.exitPct < 0 &&
      (e.closeTs || 0) >= t0).length;
  };

  const recentLoss = (entry, windowMin) => !!(entry &&
    entry.status === 'closed' && typeof entry.exitPct === 'number' && entry.exitPct < 0 &&
    Date.now() - (entry.closeTs || 0) < windowMin * 60 * 1000);

  // --- daily loss overlay (all pages) ---
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
    msg.textContent = `🛑 ${losses} losing trades today (limit ${settings.dailyLossLimit}). `
      + 'Step away — the market will still be here tomorrow.';
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

  // --- revenge-trade advisory (token page) ---
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
    const mins = Math.max(1, Math.round((Date.now() - (entry.closeTs || 0)) / 60000));
    const sym = BBD.sanitizeAlertText(entry.symbol, 20) || 'this token';
    const text = `↩️ You sold ${sym} at ${entry.exitPct}% ${mins}m ago. Buying back — thesis, or FOMO?`;
    if (el.textContent !== text) el.textContent = text;
    if (el.style.display !== 'block') el.style.display = 'block';
  };

  const tick = async () => {
    try {
      const settings = await BBD.store.settings();
      if (!settings.fomoGuardEnabled) {
        hideOverlay();
        hideRevenge();
        return;
      }
      const [journal, daystats] = await Promise.all([
        BBD.store.get(BBD.KEYS.journal, {}),
        BBD.store.get(BBD.KEYS.daystats, {})
      ]);
      const losses = lossesToday(journal);
      if (losses >= settings.dailyLossLimit && daystats.lossDismissedDay !== dayStr()) {
        showOverlay(losses, settings);
      } else {
        hideOverlay();
      }
      if (location.pathname.includes('/token/')) {
        const addr = BBD.tokenAddrFromHref(location.pathname);
        const entry = addr && journal[addr];
        if (recentLoss(entry, settings.revengeWindowMin)) showRevenge(entry);
        else hideRevenge();
      } else {
        hideRevenge();
      }
    } catch (err) {
      console.warn('[bbd] guard tick failed', err);
    }
  };

  return { tick, lossesToday, recentLoss };
})();
