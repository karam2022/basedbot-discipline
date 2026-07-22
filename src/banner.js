// Persistent take-profit banner shown on every basedbot page when any cached
// position is above the user's threshold.
'use strict';

BBD.banner = (() => {
  const notified = new Set(); // addrs already sent a Chrome notification this session

  // kind 'win': pct at/above thresholdPct, re-fires after climbing another
  // refireStepPct. kind 'loss': pct at/below -stopLossPct, re-fires after
  // dropping another refireStepPct. Same snooze/dismiss maps — a position is
  // only ever a winner or a loser at one moment, so the keys never collide.
  const eligible = (positions, settings, snoozes, dismissed, kind) => {
    const now = Date.now();
    const win = kind === 'win';
    const meets = (pct) => (win ? pct >= settings.thresholdPct : pct <= -settings.stopLossPct);
    const refired = (pct, dis) => (win
      ? pct >= dis + settings.refireStepPct
      : pct <= dis - settings.refireStepPct);
    return Object.entries(positions)
      .map(([positionKey, p]) => ({
        positionKey,
        actionKey: positionKey,
        addr: BBD.positionAddr(positionKey, p),
        ...p
      }))
      .filter((p) => typeof p.sourceTs === 'number' && Date.now() - p.sourceTs <= BBD.STALE_MS)
      .filter((p) => typeof p.pct === 'number' && meets(p.pct))
      .filter((p) => !(snoozes[p.positionKey] && snoozes[p.positionKey] > now))
      .filter((p) => {
        const dis = dismissed[p.positionKey];
        return dis === undefined || refired(p.pct, dis);
      })
      .sort((a, b) => (win ? b.pct - a.pct : a.pct - b.pct)); // most extreme first
  };

  const eligibleGivebacks = (positions, settings, snoozes, dismissed) => {
    const now = Date.now();
    const out = [];
    for (const [positionKey, p] of Object.entries(positions)) {
      if (typeof p.sourceTs !== 'number' || Date.now() - p.sourceTs > BBD.STALE_MS) continue;
      if (typeof p.pct !== 'number' || typeof p.peakPct !== 'number') continue;
      if (p.peakPct < settings.thresholdPct) continue;
      const givebackPct = p.peakPct - p.pct;
      if (givebackPct < settings.peakGivebackPct) continue;
      const actionKey = `peak:${positionKey}`;
      if (snoozes[actionKey] && snoozes[actionKey] > now) continue;
      const prior = dismissed[actionKey];
      if (prior !== undefined && givebackPct < prior + settings.refireStepPct) continue;
      out.push({
        positionKey, actionKey, ...p,
        addr: BBD.positionAddr(positionKey, p),
        peakPct: p.peakPct,
        givebackPct,
        dismissMetric: givebackPct
      });
    }
    return out.sort((a, b) => b.givebackPct - a.givebackPct);
  };

  const ensureEl = () => {
    let el = document.getElementById('bbd-banner');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'bbd-banner';
    document.body.appendChild(el);
    return el;
  };

  const hide = () => {
    const el = document.getElementById('bbd-banner');
    if (el) el.style.display = 'none';
  };

  const MAX_ROWS = 3;

  // One row per eligible position (capped), each with its own snooze and
  // dismiss — holding several winners/losers must not hide all but the biggest.
  const renderRow = (pos, settings, kind) => {
    const win = kind === 'win';
    const giveback = kind === 'giveback';
    const row = document.createElement('div');
    row.className = win ? 'bbd-banner-row'
      : giveback ? 'bbd-banner-row bbd-banner-row-giveback'
        : 'bbd-banner-row bbd-banner-row-loss';

    const stale = Date.now() - (pos.sourceTs || pos.ts || 0) > BBD.STALE_MS;
    const money = (n) => {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '';
      const sign = n > 0 ? '+' : n < 0 ? '-' : '';
      return `${sign}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    };
    const usd = typeof pos.pnlUsd === 'number' ? ` · PnL ${money(pos.pnlUsd)}`
      : pos.usd ? ` · PnL ${pos.usd}` : '';
    const sym = BBD.sanitizeAlertText(pos.symbol, 20) || pos.addr.slice(0, 8);
    const msg = document.createElement(pos.chain ? 'a' : 'span');
    msg.className = 'bbd-banner-msg';
    if (pos.chain) msg.href = `/token/${pos.chain}/${pos.addr}`;
    // pos.pct is negative for losses, so it already carries its own minus sign.
    msg.textContent = giveback
      ? `🟠 ${sym} gave back ${Math.round(pos.givebackPct * 10) / 10} points from a +${pos.peakPct}% peak ` +
        `(now ${pos.pct >= 0 ? '+' : ''}${pos.pct}%) — protect the win?`
      : win
        ? `🟢 ${sym} +${pos.pct}%${usd}${stale ? ' · stale' : ''} — take profit.`
        : `🔴 ${sym} ${pos.pct}%${usd}${stale ? ' · stale' : ''} — cut losses?`;

    const snoozeBtn = document.createElement('button');
    snoozeBtn.type = 'button';
    snoozeBtn.textContent = `Snooze ${settings.snoozeMin}m`;
    snoozeBtn.addEventListener('click', async () => {
      await BBD.store.mergeEntry(
        BBD.KEYS.snoozes, pos.actionKey, Date.now() + settings.snoozeMin * 60 * 1000
      );
      BBD.banner.tick();
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.title = win
      ? `Re-fires if it climbs another ${settings.refireStepPct} points`
      : giveback
        ? `Re-fires if another ${settings.refireStepPct} points are given back`
      : `Re-fires if it drops another ${settings.refireStepPct} points`;
    dismissBtn.addEventListener('click', async () => {
      await BBD.store.mergeEntry(BBD.KEYS.dismissed, pos.actionKey,
        typeof pos.dismissMetric === 'number' ? pos.dismissMetric : pos.pct);
      BBD.banner.tick();
    });

    row.append(msg, snoozeBtn, dismissBtn);
    return row;
  };

  const appendSection = (el, hits, settings, kind) => {
    hits.slice(0, MAX_ROWS).forEach((pos) => el.append(renderRow(pos, settings, kind)));
    if (hits.length > MAX_ROWS) {
      const more = document.createElement('div');
      more.className = 'bbd-banner-more';
      more.textContent = kind === 'win'
        ? `…and ${hits.length - MAX_ROWS} more in profit — open Portfolio.`
        : kind === 'giveback'
          ? `…and ${hits.length - MAX_ROWS} more giving back profit — open Portfolio.`
        : `…and ${hits.length - MAX_ROWS} more underwater — open Portfolio.`;
      el.append(more);
    }
  };

  const render = (winners, givebacks, losers, settings) => {
    const el = ensureEl();
    el.innerHTML = '';
    appendSection(el, winners, settings, 'win');
    appendSection(el, givebacks, settings, 'giveback');
    appendSection(el, losers, settings, 'loss');
    // Drop the celebratory green when the banner is only about losses.
    el.classList.toggle('bbd-has-loss', losers.length > 0 || givebacks.length > 0);
    el.classList.toggle('bbd-loss-only', winners.length === 0 && givebacks.length === 0 && losers.length > 0);
    el.style.display = 'flex';
  };

  // The in-memory set only rate-limits messages per page load; the background
  // worker owns the real cross-load dedupe (re-alert only on refire-step climb
  // or after 24h) so reloading pages doesn't re-spam (#1).
  const maybeNotify = async (top, settings) => {
    if (!settings.notifyEnabled || notified.has(top.positionKey)) return;
    notified.add(top.positionKey);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'bbd-notify',
        dedupe: { key: `tp:${top.positionKey}`, pct: top.pct },
        title: `${BBD.sanitizeAlertText(top.symbol, 20) || top.addr.slice(0, 8)} +${top.pct}%`,
        message: 'Position crossed your take-profit threshold on basedbot.',
        url: top.chain ? `${location.origin}/token/${top.chain}/${top.addr}` : undefined
      });
      if (!result || !result.ok) notified.delete(top.positionKey);
    } catch (err) {
      notified.delete(top.positionKey);
      console.warn('[bbd] notify failed', err);
    }
  };

  const tick = async () => {
    try {
      const settings = await BBD.store.settings();
      if (!settings.reminderEnabled && !settings.stopLossEnabled && !settings.peakGivebackEnabled) {
        hide();
        return;
      }
      const [positions, snoozes, dismissed] = await Promise.all([
        BBD.store.get(BBD.KEYS.positions, {}),
        BBD.store.get(BBD.KEYS.snoozes, {}),
        BBD.store.get(BBD.KEYS.dismissed, {})
      ]);
      const winners = settings.reminderEnabled
        ? eligible(positions, settings, snoozes, dismissed, 'win') : [];
      const givebacks = settings.peakGivebackEnabled
        ? eligibleGivebacks(positions, settings, snoozes, dismissed) : [];
      const losers = settings.stopLossEnabled
        ? eligible(positions, settings, snoozes, dismissed, 'loss')
        : [];
      if (winners.length === 0 && givebacks.length === 0 && losers.length === 0) {
        hide();
        return;
      }
      render(winners, givebacks, losers, settings);
      // Chrome notifications stay on the take-profit path (its background
      // dedupe is tuned for a rising pct); the loss nag lives in the banner.
      winners.forEach((hit) => maybeNotify(hit, settings));
    } catch (err) {
      console.warn('[bbd] banner tick failed', err);
    }
  };

  return { tick };
})();
