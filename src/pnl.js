// Position watcher: caches held positions + unrealized PnL in
// chrome.storage.local for the banner. Primary source is the balances API
// (BBD.feed, accurate + whole-wallet); token-page / portfolio-table DOM
// scraping is the fallback until that first balances fetch is tapped.
'use strict';

BBD.pnl = (() => {
  const savePosition = async (addr, symbol, pct, usd, chain) => {
    if (!addr || pct === null || Number.isNaN(pct)) return;
    await BBD.store.mergeEntry(BBD.KEYS.positions, addr, {
      symbol: symbol || addr.slice(0, 6),
      pct,
      usd: usd || null,
      chain: chain || null,
      ts: Date.now()
    });
    // Journal follows the same lifecycle the banner reads from.
    await BBD.journal.onHeld(addr, { symbol, chain, pct });
  };

  const clearPosition = async (addr) => {
    if (!addr) return;
    const positions = await BBD.store.get(BBD.KEYS.positions, {});
    if (positions[addr]) await BBD.store.removeEntry(BBD.KEYS.positions, addr);
    await BBD.journal.onClosed(addr);
  };

  // --- Token page: "Bought / Sold / Holding / Unrealized PnL" panel ---------
  const scanTokenPage = async () => {
    const addr = BBD.tokenAddrFromHref(location.pathname);
    if (!addr) return;
    const label = [...document.querySelectorAll('div,span,p')]
      .find((el) => el.childElementCount === 0 && el.textContent.trim() === 'Unrealized PnL');
    if (!label) return;

    // The value lives in a sibling/nearby node inside the same stat block.
    const block = label.closest('div')?.parentElement;
    const blockText = (block?.innerText || '').replace(/\n/g, ' ');
    const symbol = (document.title.split(' ')[0] || '').replace(/[^\w$]/g, '');

    const holdingMatch = blockText.match(/Holding\s+([\d,.]+[KMB]?)/i);
    const holdingZero = holdingMatch && /^0(\.0+)?$/.test(holdingMatch[1].replace(/,/g, ''));
    if (holdingZero) {
      await clearPosition(addr);
      return;
    }
    const pct = BBD.parsePct(blockText.split('Unrealized PnL')[1] || '');
    const usdMatch = (blockText.split('Unrealized PnL')[1] || '')
      .match(/([+-]?\$[\d,.]+[KMB]?)/);
    const chain = (location.pathname.match(/^\/token\/([^/]+)\//) || [])[1];
    if (pct !== null) {
      await savePosition(addr, symbol, pct, usdMatch ? usdMatch[1] : null, chain);
    }
  };

  // --- Portfolio page: positions table (Token/Amount/MC/Value/PnL) ----------
  const scanPortfolio = async () => {
    const tables = [...document.querySelectorAll('table')];
    const posTable = tables.find((t) => {
      const head = (t.querySelector('thead')?.innerText || '').replace(/\s+/g, ' ');
      return head.includes('Token') && head.includes('PnL') && head.includes('Value');
    });
    if (!posTable) return;

    for (const row of posTable.querySelectorAll('tbody tr')) {
      const link = row.querySelector('a[href*="/token/"]');
      const addr = link ? BBD.tokenAddrFromHref(link.getAttribute('href') || '') : null;
      if (!addr) continue;
      const cells = [...row.querySelectorAll('td')].map((td) => td.innerText.trim());
      const symbol = (cells[0] || '').split('\n')[0].trim();
      const pnlCell = cells.find((c) => BBD.parsePct(c) !== null && /[%$]/.test(c));
      const pct = BBD.parsePct(pnlCell || '');
      const usdMatch = (pnlCell || '').match(/([+-]?\$[\d,.]+[KMB]?)/);
      const chain = ((link.getAttribute('href') || '').match(/\/token\/([^/]+)\//) || [])[1];
      if (pct !== null) {
        await savePosition(addr, symbol, pct, usdMatch ? usdMatch[1] : null, chain);
      }
    }
  };

  // Authoritative source: the balances API gives the whole wallet with accurate
  // unrealized PnL, so no column-index guessing. Reconcile the store to it —
  // upsert every held token, clear anything no longer held (an empty holdings
  // list means everything was sold). Routed through save/clearPosition so the
  // journal lifecycle still fires.
  const fmtUsd = (v) => (typeof v === 'number' ? `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}` : null);
  const scanBalances = async () => {
    const held = BBD.feed.heldPositions();
    const heldAddrs = new Set(held.map((h) => h.addr));
    const positions = await BBD.store.get(BBD.KEYS.positions, {});
    for (const addr of Object.keys(positions)) {
      if (!heldAddrs.has(addr)) await clearPosition(addr);
    }
    for (const h of held) {
      if (h.pct === null) continue;
      await savePosition(h.addr, h.symbol, h.pct, fmtUsd(h.usd), h.chain);
    }
  };

  const scan = async () => {
    const settings = await BBD.store.settings();
    if (!settings.reminderEnabled) return;
    try {
      if (BBD.feed.hasBalances()) {
        // Balances tapped — authoritative for the whole wallet.
        await scanBalances();
      } else {
        // Fallback until the app's first balances fetch is seen.
        if (location.pathname.includes('/token/')) await scanTokenPage();
        if (location.pathname.startsWith('/portfolio')) await scanPortfolio();
      }
    } catch (err) {
      console.warn('[bbd] pnl scan failed', err);
    }
  };

  return { scan };
})();
