// Persistent take-profit banner shown on every basedbot page when any cached
// position is above the user's threshold.
'use strict';

BBD.banner = (() => {
  const notified = new Set(); // addrs already sent a Chrome notification this session

  const eligible = (positions, settings, snoozes, dismissed) => {
    const now = Date.now();
    return Object.entries(positions)
      .map(([addr, p]) => ({ addr, ...p }))
      .filter((p) => typeof p.pct === 'number' && p.pct >= settings.thresholdPct)
      .filter((p) => !(snoozes[p.addr] && snoozes[p.addr] > now))
      .filter((p) => {
        const dis = dismissed[p.addr];
        return dis === undefined || p.pct >= dis + settings.refireStepPct;
      })
      .sort((a, b) => b.pct - a.pct);
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

  const render = (top, extraCount, settings) => {
    const el = ensureEl();
    const stale = Date.now() - top.ts > BBD.STALE_MS;
    const usd = top.usd ? ` (${top.usd})` : '';
    const staleNote = stale ? ' · stale, open Portfolio to refresh' : '';
    const more = extraCount > 0 ? ` · +${extraCount} more in profit` : '';
    el.innerHTML = '';

    const msg = document.createElement('span');
    msg.className = 'bbd-banner-msg';
    msg.textContent =
      `🟢 ${top.symbol} is +${top.pct}%${usd} — you told yourself you'd take profit.${more}${staleNote}`;

    const snoozeBtn = document.createElement('button');
    snoozeBtn.type = 'button';
    snoozeBtn.textContent = `Snooze ${settings.snoozeMin}m`;
    snoozeBtn.addEventListener('click', async () => {
      await BBD.store.mergeEntry(
        BBD.KEYS.snoozes, top.addr, Date.now() + settings.snoozeMin * 60 * 1000
      );
      hide();
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.title = `Re-fires if it climbs another ${settings.refireStepPct} points`;
    dismissBtn.addEventListener('click', async () => {
      await BBD.store.mergeEntry(BBD.KEYS.dismissed, top.addr, top.pct);
      hide();
    });

    el.append(msg, snoozeBtn, dismissBtn);
    el.style.display = 'flex';
  };

  const maybeNotify = (top, settings) => {
    if (!settings.notifyEnabled || notified.has(top.addr)) return;
    notified.add(top.addr);
    try {
      chrome.runtime.sendMessage({
        type: 'bbd-notify',
        title: `${top.symbol} +${top.pct}%`,
        message: 'Position crossed your take-profit threshold on basedbot.',
        url: top.chain ? `${location.origin}/token/${top.chain}/${top.addr}` : undefined
      });
    } catch (err) {
      console.warn('[bbd] notify failed', err);
    }
  };

  const tick = async () => {
    try {
      const settings = await BBD.store.settings();
      if (!settings.reminderEnabled) {
        hide();
        return;
      }
      const [positions, snoozes, dismissed] = await Promise.all([
        BBD.store.get(BBD.KEYS.positions, {}),
        BBD.store.get(BBD.KEYS.snoozes, {}),
        BBD.store.get(BBD.KEYS.dismissed, {})
      ]);
      const hits = eligible(positions, settings, snoozes, dismissed);
      if (hits.length === 0) {
        hide();
        return;
      }
      render(hits[0], hits.length - 1, settings);
      maybeNotify(hits[0], settings);
    } catch (err) {
      console.warn('[bbd] banner tick failed', err);
    }
  };

  return { tick };
})();
