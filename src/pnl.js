// Position watcher. Balance snapshots are authoritative while fresh and are
// serialized by the service worker; DOM parsing remains a narrow fallback.
'use strict';

BBD.pnl = (() => {
  const trackingNeeded = (s) => s.reminderEnabled || s.stopLossEnabled || s.peakGivebackEnabled ||
    s.journalEnabled || s.fomoGuardEnabled || s.dumpAlertsEnabled;

  const savePosition = async (addr, symbol, pct, pnlUsd, chain) => {
    if (!addr || typeof pct !== 'number' || Number.isNaN(pct)) return;
    const sourceTs = Date.now();
    const positionKey = BBD.positionKey(addr, chain, null);
    const current = await BBD.store.get(BBD.KEYS.positions, {});
    const next = { ...current };
    // Remove an address-only legacy copy of the same position during migration.
    for (const [key, p] of Object.entries(next)) {
      if (key !== positionKey && BBD.positionIsToken(key, p, addr, chain)) delete next[key];
    }
    const pos = {
      positionKey,
      addr,
      symbol: symbol || addr.slice(0, 6),
      pct,
      peakPct: Math.max(typeof current[positionKey]?.peakPct === 'number'
        ? current[positionKey].peakPct : pct, pct),
      pnlUsd: typeof pnlUsd === 'number' ? pnlUsd : null,
      valueUsd: null,
      chain: chain || null,
      wallet: null,
      sourceTs,
      ts: sourceTs
    };
    next[positionKey] = pos;
    await BBD.store.set(BBD.KEYS.positions, next);
    await BBD.store.set(BBD.KEYS.positionsMeta, {
      source: 'dom-fallback', sourceTs, syncedTs: sourceTs, count: Object.keys(next).length
    });
    await BBD.journal.onHeld(positionKey, pos);
  };

  const clearPosition = async (addr, chain) => {
    if (!addr) return;
    const positions = await BBD.store.get(BBD.KEYS.positions, {});
    const next = { ...positions };
    const removed = [];
    for (const [key, p] of Object.entries(positions)) {
      if (BBD.positionIsToken(key, p, addr, chain)) {
        removed.push(key);
        delete next[key];
      }
    }
    if (!removed.length) return;
    const closeTs = Date.now();
    await BBD.store.set(BBD.KEYS.positions, next);
    for (const key of removed) await BBD.journal.onClosed(key, closeTs);
  };

  const parseUsd = (text) => {
    if (typeof text !== 'string') return null;
    const m = text.match(/([+-]?)\$([\d,.]+)([KMB]?)/i);
    if (!m) return null;
    const mult = m[3].toUpperCase() === 'B' ? 1e9 : m[3].toUpperCase() === 'M' ? 1e6
      : m[3].toUpperCase() === 'K' ? 1e3 : 1;
    const n = Number(m[2].replace(/,/g, '')) * mult;
    return Number.isFinite(n) ? (m[1] === '-' ? -n : n) : null;
  };

  const scanTokenPage = async () => {
    const addr = BBD.tokenAddrFromHref(location.pathname);
    if (!addr) return;
    const label = [...document.querySelectorAll('div,span,p')]
      .find((el) => el.childElementCount === 0 && el.textContent.trim() === 'Unrealized PnL');
    if (!label) return;
    const block = label.closest('div')?.parentElement;
    const blockText = (block?.innerText || '').replace(/\n/g, ' ');
    const symbol = (document.title.split(' ')[0] || '').replace(/[^\w$]/g, '');
    const chain = (location.pathname.match(/^\/token\/([^/]+)\//) || [])[1];

    const holdingMatch = blockText.match(/Holding\s+([\d,.]+[KMB]?)/i);
    const holdingZero = holdingMatch && /^0(\.0+)?$/.test(holdingMatch[1].replace(/,/g, ''));
    if (holdingZero) {
      await clearPosition(addr, chain);
      return;
    }
    const pnlText = blockText.split('Unrealized PnL')[1] || '';
    const pct = BBD.parsePct(pnlText);
    if (pct !== null) await savePosition(addr, symbol, pct, parseUsd(pnlText), chain);
  };

  const scanPortfolio = async () => {
    const tables = [...document.querySelectorAll('table')];
    const posTable = tables.find((t) => {
      const head = (t.querySelector('thead')?.innerText || '').replace(/\s+/g, ' ');
      return head.includes('Token') && head.includes('PnL') && head.includes('Value');
    });
    if (!posTable) return;
    for (const row of posTable.querySelectorAll('tbody tr')) {
      const link = row.querySelector('a[href*="/token/"]');
      const href = link && link.getAttribute('href') || '';
      const addr = BBD.tokenAddrFromHref(href);
      if (!addr) continue;
      const cells = [...row.querySelectorAll('td')].map((td) => td.innerText.trim());
      const symbol = (cells[0] || '').split('\n')[0].trim();
      const pnlCell = cells.find((c) => BBD.parsePct(c) !== null && /[%$]/.test(c));
      const pct = BBD.parsePct(pnlCell || '');
      const chain = (href.match(/\/token\/([^/]+)\//) || [])[1];
      if (pct !== null) await savePosition(addr, symbol, pct, parseUsd(pnlCell), chain);
    }
  };

  const scanBalances = async () => {
    const sourceTs = BBD.feed.balancesUpdatedAt();
    if (!sourceTs) return;
    const positions = Object.fromEntries(BBD.feed.heldPositions()
      .filter((p) => p.positionKey && typeof p.pct === 'number')
      .map((p) => [p.positionKey, { ...p, ts: p.sourceTs }]));
    const result = await chrome.runtime.sendMessage({
      type: 'bbd-sync-positions', sourceTs, positions
    });
    if (result && result.accepted) {
      await BBD.journal.reconcile(result.previous || {}, result.positions || positions, sourceTs);
    }
  };

  const scan = async () => {
    const settings = await BBD.store.settings();
    if (!trackingNeeded(settings)) return;
    try {
      if (BBD.feed.hasFreshBalances()) {
        await scanBalances();
      } else {
        // Never promote an old API cache by refreshing its timestamps. When it
        // expires, use only currently visible DOM evidence until a new response arrives.
        if (location.pathname.includes('/token/')) await scanTokenPage();
        if (location.pathname.startsWith('/portfolio')) await scanPortfolio();
      }
    } catch (err) {
      console.warn('[bbd] pnl scan failed', err);
    }
  };

  return { scan, trackingNeeded };
})();
