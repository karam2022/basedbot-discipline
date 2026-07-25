// The holder list (/api/token/{addr}/holders) carries what the trade tape only
// approximates: every holder's supply share, running PnL, and — when present —
// the wallet that funded them. Wallets fed from one source are the split-buy
// pattern the launch research describes, counted here so nine wallets from one
// funder read as one actor rather than nine independent holders. And holders
// sitting in profit are the ones who can exit cheaply, which is the pressure a
// scalp cares about. Pure and aggregate-only: addresses never leave this file.
'use strict';

BBD.holders = (() => {
  const DEFAULTS = Object.freeze({
    minHolders: 20,       // below this the percentages are too few to trust
    minClusterWallets: 3  // a funder feeding this many wallets is worth naming
  });

  const finite = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  const option = (options, key) => {
    try {
      const raw = options && typeof options === 'object' ? options[key] : undefined;
      const n = finite(raw);
      return n !== null && n > 0 ? n : DEFAULTS[key];
    } catch (err) {
      return DEFAULTS[key];
    }
  };

  const share = (part, whole) =>
    whole > 0 ? Math.round((part / whole) * 100) : null;

  // EVM funder addresses vary in case between endpoints; base58 does not.
  const funderKey = (row) => {
    const raw = row && (row.funding_source_address_full || row.funding_source_address);
    if (typeof raw !== 'string' || !raw) return null;
    return raw.startsWith('0x') ? raw.toLowerCase() : raw;
  };

  const empty = () => ({
    enough: false,
    holderCount: 0,
    inProfitPct: null,
    fundedWallets: 0,
    topClusterWallets: 0,
    topClusterPct: null,
    clusteredWallets: 0,
    clusteredPct: null
  });

  const round1 = (value) => Math.round(value * 10) / 10;

  const analyze = (rows, options) => {
    const result = empty();
    try {
      if (!Array.isArray(rows) || !rows.length) return result;
      const minHolders = option(options, 'minHolders');
      const minClusterWallets = option(options, 'minClusterWallets');

      let holderCount = 0;
      let pnlKnown = 0;
      let inProfit = 0;
      const funders = new Map(); // funder -> { wallets, pct }

      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        holderCount += 1;

        const pnl = finite(row.total_pnl_usd);
        if (pnl !== null) {
          pnlKnown += 1;
          if (pnl > 0) inProfit += 1;
        }

        const key = funderKey(row);
        if (key) {
          const entry = funders.get(key) || { wallets: 0, pct: 0 };
          entry.wallets += 1;
          const pct = finite(row.percentage);
          if (pct !== null) entry.pct += pct;
          funders.set(key, entry);
        }
      }

      result.holderCount = holderCount;
      // Profit share is only meaningful when most rows actually carry PnL.
      if (pnlKnown >= minHolders) result.inProfitPct = share(inProfit, pnlKnown);

      let fundedWallets = 0;
      let top = null;
      let clusteredWallets = 0;
      let clusteredPct = 0;
      for (const entry of funders.values()) {
        fundedWallets += entry.wallets;
        if (entry.wallets >= minClusterWallets) {
          clusteredWallets += entry.wallets;
          clusteredPct += entry.pct;
          if (!top || entry.wallets > top.wallets ||
            (entry.wallets === top.wallets && entry.pct > top.pct)) {
            top = entry;
          }
        }
      }
      result.fundedWallets = fundedWallets;
      if (top) {
        result.topClusterWallets = top.wallets;
        result.topClusterPct = round1(top.pct);
        result.clusteredWallets = clusteredWallets;
        result.clusteredPct = round1(clusteredPct);
      }

      result.enough = holderCount >= minHolders;
      return result;
    } catch (err) {
      return empty();
    }
  };

  return { DEFAULTS, analyze };
})();
