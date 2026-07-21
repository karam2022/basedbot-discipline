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

  const MAX_ROWS = 3;

  // One row per profitable position (capped), each with its own snooze and
  // dismiss — holding several winners must not hide all but the biggest.
  const renderRow = (pos, settings) => {
    const row = document.createElement('div');
    row.className = 'bbd-banner-row';

    const stale = Date.now() - pos.ts > BBD.STALE_MS;
    const usd = pos.usd ? ` (${pos.usd})` : '';
    const msg = document.createElement(pos.chain ? 'a' : 'span');
    msg.className = 'bbd-banner-msg';
    if (pos.chain) msg.href = `/token/${pos.chain}/${pos.addr}`;
    msg.textContent =
      `🟢 ${BBD.sanitizeAlertText(pos.symbol, 20) || pos.addr.slice(0, 8)} +${pos.pct}%${usd}` +
      `${stale ? ' · stale' : ''} — take profit.`;

    const snoozeBtn = document.createElement('button');
    snoozeBtn.type = 'button';
    snoozeBtn.textContent = `Snooze ${settings.snoozeMin}m`;
    snoozeBtn.addEventListener('click', async () => {
      await BBD.store.mergeEntry(
        BBD.KEYS.snoozes, pos.addr, Date.now() + settings.snoozeMin * 60 * 1000
      );
      BBD.banner.tick();
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.title = `Re-fires if it climbs another ${settings.refireStepPct} points`;
    dismissBtn.addEventListener('click', async () => {
      await BBD.store.mergeEntry(BBD.KEYS.dismissed, pos.addr, pos.pct);
      BBD.banner.tick();
    });

    row.append(msg, snoozeBtn, dismissBtn);
    return row;
  };

  const render = (hits, settings) => {
    const el = ensureEl();
    el.innerHTML = '';
    hits.slice(0, MAX_ROWS).forEach((pos) => el.append(renderRow(pos, settings)));
    if (hits.length > MAX_ROWS) {
      const more = document.createElement('div');
      more.className = 'bbd-banner-more';
      more.textContent = `…and ${hits.length - MAX_ROWS} more in profit — open Portfolio.`;
      el.append(more);
    }
    el.style.display = 'flex';
  };

  // The in-memory set only rate-limits messages per page load; the background
  // worker owns the real cross-load dedupe (re-alert only on refire-step climb
  // or after 24h) so reloading pages doesn't re-spam (#1).
  const maybeNotify = (top, settings) => {
    if (!settings.notifyEnabled || notified.has(top.addr)) return;
    notified.add(top.addr);
    try {
      chrome.runtime.sendMessage({
        type: 'bbd-notify',
        dedupe: { key: `tp:${top.addr}`, pct: top.pct },
        title: `${BBD.sanitizeAlertText(top.symbol, 20) || top.addr.slice(0, 8)} +${top.pct}%`,
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
      render(hits, settings);
      hits.forEach((hit) => maybeNotify(hit, settings));
    } catch (err) {
      console.warn('[bbd] banner tick failed', err);
    }
  };

  return { tick };
})();
