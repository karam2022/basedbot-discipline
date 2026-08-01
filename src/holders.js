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

  const addrKey = (value) => {
    if (typeof value !== 'string' || !value) return null;
    return value.startsWith('0x') ? value.toLowerCase() : value;
  };

  // The pool is not a holder. On a Solana bonding curve it sits at rank 1 with
  // most of the supply — 100% before anyone has bought, 85% early on — so
  // counting it makes every fresh launch read as extreme concentration and
  // wastes a slot in the tracked top-N, where it can never appear as a trader.
  // The API labels the row itself ("liquidityPool"); the known pool address is
  // a fallback for any list that omits the label.
  const isPoolRow = (row, poolKey) => {
    if (!row) return false;
    if (Array.isArray(row.labels) && row.labels.some((l) =>
      typeof l === 'string' && l.toLowerCase().replace(/[^a-z]/g, '') === 'liquiditypool')) {
      return true;
    }
    return poolKey !== null && addrKey(row.address) === poolKey;
  };

  const withoutPool = (rows, options) => {
    const poolKey = addrKey(options && options.poolAddress);
    return rows.filter((row) => !isPoolRow(row, poolKey));
  };

  const analyze = (rawRows, options) => {
    const result = empty();
    try {
      if (!Array.isArray(rawRows) || !rawRows.length) return result;
      const rows = withoutPool(rawRows, options);
      if (!rows.length) return result;
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

  const TRACK_DEFAULTS = Object.freeze({
    topN: 10,
    windowMs: 5 * 60 * 1000
  });

  const trackOption = (options, key) => {
    try {
      const raw = options && typeof options === 'object' ? options[key] : undefined;
      const n = finite(raw);
      return n !== null && n > 0 ? n : TRACK_DEFAULTS[key];
    } catch (err) {
      return TRACK_DEFAULTS[key];
    }
  };

  const walletKey = (value) => {
    if (typeof value !== 'string' || !value) return null;
    return value.startsWith('0x') ? value.toLowerCase() : value;
  };

  // The tape proxy (top-3 volume share) answers "is volume concentrated"; this
  // answers "are the actual biggest holders selling right now", by matching the
  // rolling tape against the real top-N holder addresses. Addresses are read to
  // match and discarded; only the counts and net flow come back.
  const trackFlow = (rawHolderRows, tapeRows, options) => {
    const holderRows = Array.isArray(rawHolderRows)
      ? withoutPool(rawHolderRows, options) : rawHolderRows;
    const result = {
      enough: false,
      tracked: 0,
      sellers: 0,
      buyers: 0,
      soldUsd: 0,
      boughtUsd: 0,
      netUsd: 0
    };
    try {
      if (!Array.isArray(holderRows) || !holderRows.length ||
        !Array.isArray(tapeRows) || !tapeRows.length) return result;
      const topN = Math.round(trackOption(options, 'topN'));
      const windowMs = trackOption(options, 'windowMs');
      const now = finite(options && options.now);
      const end = now !== null ? now : Date.now();

      const ranked = holderRows
        .map((h, i) => ({ key: walletKey(h && h.address), rank: finite(h && h.rank), i }))
        .filter((h) => h.key);
      ranked.sort((a, b) => {
        const ra = a.rank !== null ? a.rank : Infinity;
        const rb = b.rank !== null ? b.rank : Infinity;
        return ra !== rb ? ra - rb : a.i - b.i;
      });
      const top = new Set(ranked.slice(0, topN).map((h) => h.key));
      if (!top.size) return result;
      result.tracked = top.size;

      const start = end - windowMs;
      const sold = new Set();
      const bought = new Set();
      for (const row of tapeRows) {
        if (!row) continue;
        const ts = finite(row.ts);
        if (ts === null || ts < start) continue;
        const key = walletKey(row.trader);
        if (!key || !top.has(key)) continue;
        const usd = finite(row.volumeUsd) || 0;
        if (row.isBuy === true) {
          bought.add(key);
          result.boughtUsd += usd;
        } else {
          sold.add(key);
          result.soldUsd += usd;
        }
      }
      result.sellers = sold.size;
      result.buyers = bought.size;
      result.soldUsd = Math.round(result.soldUsd);
      result.boughtUsd = Math.round(result.boughtUsd);
      result.netUsd = result.boughtUsd - result.soldUsd;
      result.enough = true;
      return result;
    } catch (err) {
      return result;
    }
  };

  return { DEFAULTS, TRACK_DEFAULTS, analyze, trackFlow };
})();
