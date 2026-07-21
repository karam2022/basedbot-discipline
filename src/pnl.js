// Position watcher: reads PnL from token pages and the portfolio positions
// table, caches results in chrome.storage.local for the banner.
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
  };

  const clearPosition = async (addr) => {
    if (!addr) return;
    const positions = await BBD.store.get(BBD.KEYS.positions, {});
    if (positions[addr]) await BBD.store.removeEntry(BBD.KEYS.positions, addr);
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

  const scan = async () => {
    const settings = await BBD.store.settings();
    if (!settings.reminderEnabled) return;
    try {
      if (location.pathname.includes('/token/')) await scanTokenPage();
      if (location.pathname.startsWith('/portfolio')) await scanPortfolio();
    } catch (err) {
      console.warn('[bbd] pnl scan failed', err);
    }
  };

  return { scan };
})();
