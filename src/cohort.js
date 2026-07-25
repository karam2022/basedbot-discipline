// Who is in the trade, and have they already left? Coordinated extraction has
// a documented shape — the profitable snipers in Pine Analytics' launch study
// were out inside a minute, and deployers split buys across a handful of
// throwaway wallets to fake breadth. Both are countable from the tape, so they
// are counted here rather than guessed at by a model.
//
// Every number carries the sample it came from. A share computed over four
// wallets is noise wearing a percent sign, so the caller is handed `enough`
// and is expected to stay quiet when it is false.
'use strict';

BBD.cohort = (() => {
  const DEFAULTS = Object.freeze({
    earlyWindowMs: 60 * 1000,
    flipWindowMs: 5 * 60 * 1000,
    minWallets: 12,
    minObservedMs: 90 * 1000
  });

  const finite = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  const positive = (value) => {
    const n = finite(value);
    return n !== null && n > 0 ? n : null;
  };

  const option = (options, key) => {
    try {
      const raw = options && typeof options === 'object' ? options[key] : undefined;
      return positive(raw) === null ? DEFAULTS[key] : raw;
    } catch (err) {
      return DEFAULTS[key];
    }
  };

  // EVM addresses vary in case between endpoints; base58 does not.
  const walletKey = (trader) => {
    if (typeof trader !== 'string' || !trader) return null;
    return trader.startsWith('0x') ? trader.toLowerCase() : trader;
  };

  const share = (part, whole) =>
    whole > 0 ? Math.round((part / whole) * 100) : null;

  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };

  const empty = () => ({
    enough: false,
    walletCount: 0,
    observedMin: 0,
    earlyWallets: 0,
    earlyExitedPct: null,
    flipperPct: null,
    medianHoldSec: null,
    oneTimeWalletPct: null,
    tradesPerWallet: null
  });

  // `rows` are BBD.feed.tapeFor output: { ts, trader, isBuy, volumeUsd }.
  const analyze = (rows, options) => {
    const result = empty();
    try {
      if (!Array.isArray(rows) || !rows.length) return result;
      const earlyWindowMs = option(options, 'earlyWindowMs');
      const flipWindowMs = option(options, 'flipWindowMs');
      const minWallets = option(options, 'minWallets');
      const minObservedMs = option(options, 'minObservedMs');

      const wallets = new Map();
      let firstTs = Infinity;
      let lastTs = -Infinity;

      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const ts = finite(row.ts);
        const key = walletKey(row.trader);
        if (ts === null || !key) continue;
        if (ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;

        let wallet = wallets.get(key);
        if (!wallet) {
          wallet = { trades: 0, firstBuyTs: null, lastSellTs: null, firstTs: ts };
          wallets.set(key, wallet);
        }
        wallet.trades += 1;
        if (ts < wallet.firstTs) wallet.firstTs = ts;
        if (row.isBuy === true) {
          if (wallet.firstBuyTs === null || ts < wallet.firstBuyTs) wallet.firstBuyTs = ts;
        } else if (wallet.lastSellTs === null || ts > wallet.lastSellTs) {
          wallet.lastSellTs = ts;
        }
      }

      const walletCount = wallets.size;
      result.walletCount = walletCount;
      if (!walletCount || firstTs === Infinity) return result;

      const observedMs = Math.max(0, lastTs - firstTs);
      result.observedMin = Math.round((observedMs / 60000) * 10) / 10;

      // "Early" is relative to the oldest row we hold, not to the token's
      // launch — without backfill those differ, and claiming otherwise would
      // read as a statement about the launch that we cannot support.
      const earlyCutoff = firstTs + earlyWindowMs;
      let early = 0;
      let earlyExited = 0;
      let flippers = 0;
      let oneTime = 0;
      let totalTrades = 0;
      const holdTimes = [];

      for (const wallet of wallets.values()) {
        totalTrades += wallet.trades;
        if (wallet.trades === 1) oneTime += 1;

        if (wallet.firstTs <= earlyCutoff) {
          early += 1;
          if (wallet.lastSellTs !== null) earlyExited += 1;
        }

        // A round trip inside the window is the extraction signature; a wallet
        // that only ever sold may have bought before we started watching.
        if (wallet.firstBuyTs !== null && wallet.lastSellTs !== null &&
          wallet.lastSellTs > wallet.firstBuyTs) {
          const held = wallet.lastSellTs - wallet.firstBuyTs;
          if (held <= flipWindowMs) {
            flippers += 1;
            holdTimes.push(Math.round(held / 1000));
          }
        }
      }

      result.earlyWallets = early;
      result.earlyExitedPct = share(earlyExited, early);
      result.flipperPct = share(flippers, walletCount);
      result.medianHoldSec = median(holdTimes);
      result.oneTimeWalletPct = share(oneTime, walletCount);
      result.tradesPerWallet = Math.round((totalTrades / walletCount) * 10) / 10;
      result.enough = walletCount >= minWallets && observedMs >= minObservedMs;
      return result;
    } catch (err) {
      return empty();
    }
  };

  const LAUNCH_DEFAULTS = Object.freeze({
    buyWindowMs: 60 * 1000,
    measureMs: 5 * 60 * 1000,
    minWallets: 8
  });

  const launchOption = (options, key) => {
    try {
      const raw = options && typeof options === 'object' ? options[key] : undefined;
      return positive(raw) === null ? LAUNCH_DEFAULTS[key] : raw;
    } catch (err) {
      return LAUNCH_DEFAULTS[key];
    }
  };

  // Unlike analyze(), this reads the token's oldest page, where buy and sell
  // both sit inside the same window — so "bought in the first minute, gone by
  // the fifth" is measured rather than inferred across a gap. That is the exact
  // shape the launch research reports, which is why it gets its own function
  // instead of a parameter on the rolling one.
  const launchAnalyze = (rows, options) => {
    const result = {
      enough: false,
      cohortWallets: 0,
      exitedPct: null,
      medianExitSec: null,
      spanMin: 0
    };
    try {
      if (!Array.isArray(rows) || !rows.length) return result;
      const buyWindowMs = launchOption(options, 'buyWindowMs');
      const measureMs = launchOption(options, 'measureMs');
      const minWallets = launchOption(options, 'minWallets');

      let firstTs = Infinity;
      let lastTs = -Infinity;
      for (const r of rows) {
        const ts = finite(r && r.ts);
        if (ts === null) continue;
        if (ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }
      if (firstTs === Infinity) return result;
      result.spanMin = Math.round(((lastTs - firstTs) / 60000) * 10) / 10;

      const buyDeadline = firstTs + buyWindowMs;
      const exitDeadline = firstTs + measureMs;
      const cohort = new Map(); // wallet -> first buy ts

      for (const r of rows) {
        if (!r || r.isBuy !== true) continue;
        const ts = finite(r.ts);
        const key = walletKey(r.trader);
        if (ts === null || !key || ts > buyDeadline) continue;
        if (!cohort.has(key) || ts < cohort.get(key)) cohort.set(key, ts);
      }
      result.cohortWallets = cohort.size;
      if (!cohort.size) return result;

      const exitTimes = [];
      const exited = new Set();
      for (const r of rows) {
        if (!r || r.isBuy !== false) continue;
        const ts = finite(r.ts);
        const key = walletKey(r.trader);
        if (ts === null || !key || ts > exitDeadline) continue;
        const boughtAt = cohort.get(key);
        if (boughtAt === undefined || ts < boughtAt || exited.has(key)) continue;
        exited.add(key);
        exitTimes.push(Math.round((ts - boughtAt) / 1000));
      }

      result.exitedPct = share(exited.size, cohort.size);
      result.medianExitSec = median(exitTimes);
      result.enough = cohort.size >= minWallets;
      return result;
    } catch (err) {
      return result;
    }
  };

  return { DEFAULTS, LAUNCH_DEFAULTS, analyze, launchAnalyze };
})();
