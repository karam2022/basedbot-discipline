// Pure tape aggregation for Phase 2: no page state, I/O, or timers.
'use strict';

BBD.candles = (() => {
  const emptyFlow = () => ({
    buyRatio: null,
    uniqueBuyers: 0,
    uniqueSellers: 0,
    top3TraderShare: null,
    proTraderNetUsd: 0,
    sniperNetUsd: 0,
    devSold: false,
    volumeTrend: null,
    tradeCount: 0
  });

  const emptyChanges = () => ({
    changePct1m: null,
    changePct5m: null,
    changePct15m: null
  });

  const number = (value) => {
    try {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    } catch (err) {
      return null;
    }
  };

  const nonNegative = (value) => {
    const n = number(value);
    return n !== null && n >= 0 ? n : null;
  };

  const positive = (value) => {
    const n = number(value);
    return n !== null && n > 0 ? n : null;
  };

  const safeAdd = (a, b) => {
    const sum = a + b;
    if (Number.isFinite(sum)) return sum;
    return sum < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE;
  };

  const ratio = (numerator, denominator) => {
    if (!(denominator > 0)) return null;
    const result = numerator / denominator;
    return Number.isFinite(result) ? result : null;
  };

  const parseTs = (value) => {
    try {
      return BBD.parseTradeTimestamp(value);
    } catch (err) {
      return null;
    }
  };

  // Confirmed-only metrics do not flicker when a preconfirmation disappears
  // or lands in a different order. A missing flag is accepted for older API
  // payloads; only the explicit unconfirmed state is excluded.
  // Solana rows come from Mobula (api/2/token/trades) and describe the same
  // trade in a different vocabulary: epoch-ms `date`, a "buy"/"sell" `type`,
  // camelCase USD amounts and a `labels` array in place of the is_* booleans.
  // Solana has no block/log index, so ordering falls back to the tx hash.
  const svmTrade = (trade, now) => {
    if (typeof trade.transactionHash !== 'string' || !trade.transactionHash) return null;
    const type = typeof trade.type === 'string' ? trade.type.toLowerCase() : '';
    // An unrecognized operation must be dropped, not read as a sell.
    if (type !== 'buy' && type !== 'sell') return null;
    const ts = nonNegative(trade.date);
    if (ts === null || ts === 0 || ts > now) return null;
    const label = (needle) => Array.isArray(trade.labels) &&
      trade.labels.some((l) => typeof l === 'string' && l.toLowerCase().includes(needle));
    return {
      ts,
      isBuy: type === 'buy',
      volume: nonNegative(trade.baseTokenAmountUSD) ??
        nonNegative(trade.quoteTokenAmountUSD) ?? 0,
      trader: typeof trade.swapSenderAddress === 'string' ? trade.swapSenderAddress
        : (typeof trade.transactionSenderAddress === 'string'
          ? trade.transactionSenderAddress : ''),
      isPro: label('protrader'),
      isSniper: label('sniper'),
      block: null,
      logIndex: null,
      txHash: trade.transactionHash
    };
  };

  const baseTrade = (trade, now) => {
    try {
      if (!trade || typeof trade !== 'object' || trade.preconfirm === true) return null;
      if (trade.is_buy !== true && trade.is_buy !== false) return svmTrade(trade, now);
      const ts = parseTs(trade.timestamp);
      if (ts === null || ts > now) return null;
      return {
        ts,
        isBuy: trade.is_buy,
        volume: nonNegative(trade.volume_usd) ?? 0,
        trader: typeof trade.trader_full === 'string' ? trade.trader_full : '',
        isPro: trade.is_pro_trader === true,
        isSniper: trade.is_sniper === true,
        block: nonNegative(trade.block),
        logIndex: nonNegative(trade.log_index),
        txHash: typeof trade.tx_hash === 'string' ? trade.tx_hash : ''
      };
    } catch (err) {
      return null;
    }
  };

  // Same-second trades are common, so block/log order keeps OHLC stable even
  // when the API page itself arrives in an arbitrary order.
  const compareTrades = (a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.block !== b.block) {
      if (a.block === null) return 1;
      if (b.block === null) return -1;
      return a.block - b.block;
    }
    if (a.logIndex !== b.logIndex) {
      if (a.logIndex === null) return 1;
      if (b.logIndex === null) return -1;
      return a.logIndex - b.logIndex;
    }
    if (a.txHash < b.txHash) return -1;
    if (a.txHash > b.txHash) return 1;
    return 0;
  };

  const build = (trades, options) => {
    try {
      const opts = options && typeof options === 'object' ? options : {};
      const bucketMs = positive(opts.bucketMs);
      const now = nonNegative(opts.now);
      if (!Array.isArray(trades) || bucketMs === null || now === null) return [];

      const rows = [];
      for (const trade of trades) {
        const row = baseTrade(trade, now);
        if (!row) continue;
        try {
          const price = nonNegative(trade.price_usd) ??
            nonNegative(trade.baseTokenPriceUSD);
          if (price === null) continue;
          rows.push({ ...row, price });
        } catch (err) {
          // One hostile row must not discard valid tape beside it.
        }
      }
      rows.sort(compareTrades);

      const candles = [];
      for (const row of rows) {
        const t = Math.floor(row.ts / bucketMs) * bucketMs;
        let candle = candles[candles.length - 1];
        if (!candle || candle.t !== t) {
          candle = {
            t,
            o: row.price,
            h: row.price,
            l: row.price,
            c: row.price,
            v: row.volume,
            buys: row.isBuy ? 1 : 0,
            sells: row.isBuy ? 0 : 1
          };
          candles.push(candle);
          continue;
        }
        candle.h = Math.max(candle.h, row.price);
        candle.l = Math.min(candle.l, row.price);
        candle.c = row.price;
        candle.v = safeAdd(candle.v, row.volume);
        if (row.isBuy) candle.buys += 1;
        else candle.sells += 1;
      }
      // Gaps stay absent: carrying the last close forward would claim tape
      // coverage the single API page does not provide.
      return candles;
    } catch (err) {
      return [];
    }
  };

  const sameAddr = (a, b) => {
    if (!a || !b) return false;
    return a.startsWith('0x') && b.startsWith('0x')
      ? a.toLowerCase() === b.toLowerCase()
      : a === b; // base58 addresses are case-sensitive
  };

  const traderKey = (address) => {
    if (!address) return null;
    return address.startsWith('0x') ? address.toLowerCase() : address;
  };

  const flow = (trades, options) => {
    const result = emptyFlow();
    try {
      const opts = options && typeof options === 'object' ? options : {};
      const windowMs = positive(opts.windowMs);
      const now = nonNegative(opts.now);
      if (!Array.isArray(trades) || windowMs === null || now === null) return result;
      let creator = null;
      try {
        creator = opts.creatorAddr ? String(opts.creatorAddr) : null;
      } catch (err) {
        creator = null;
      }

      const start = now - windowMs;
      const midpoint = start + windowMs / 2;
      let buyVolume = 0;
      let totalVolume = 0;
      let olderVolume = 0;
      let recentVolume = 0;
      const buyers = new Set();
      const sellers = new Set();
      const traderVolumes = new Map();

      for (const trade of trades) {
        const row = baseTrade(trade, now);
        if (!row || row.ts < start) continue;
        result.tradeCount += 1;
        totalVolume = safeAdd(totalVolume, row.volume);
        if (row.isBuy) buyVolume = safeAdd(buyVolume, row.volume);
        if (row.ts < midpoint) olderVolume = safeAdd(olderVolume, row.volume);
        else recentVolume = safeAdd(recentVolume, row.volume);

        const key = traderKey(row.trader);
        if (key) {
          if (row.isBuy) buyers.add(key);
          else sellers.add(key);
          traderVolumes.set(key, safeAdd(traderVolumes.get(key) || 0, row.volume));
        }

        const signedVolume = row.isBuy ? row.volume : -row.volume;
        if (row.isPro) {
          result.proTraderNetUsd = safeAdd(result.proTraderNetUsd, signedVolume);
        }
        if (row.isSniper) {
          result.sniperNetUsd = safeAdd(result.sniperNetUsd, signedVolume);
        }
        if (!row.isBuy && creator && sameAddr(row.trader, creator)) result.devSold = true;
      }

      result.buyRatio = ratio(buyVolume, totalVolume);
      result.uniqueBuyers = buyers.size;
      result.uniqueSellers = sellers.size;
      const top3Volume = [...traderVolumes.values()]
        .sort((a, b) => b - a)
        .slice(0, 3)
        .reduce((sum, volume) => safeAdd(sum, volume), 0);
      result.top3TraderShare = ratio(top3Volume, totalVolume);
      result.volumeTrend = ratio(recentVolume, olderVolume);
      return result;
    } catch (err) {
      return result;
    }
  };

  // Changes are derived from one-minute build() output so all price validation
  // and confirmation rules stay in one place. A missing boundary candle falls
  // back to the latest earlier close; insufficient history stays null.
  const priceChanges = (candles, options) => {
    const result = emptyChanges();
    try {
      const opts = options && typeof options === 'object' ? options : {};
      const now = nonNegative(opts.now);
      if (!Array.isArray(candles) || now === null) return result;
      const rows = [];
      for (const candle of candles) {
        try {
          if (!candle || typeof candle !== 'object') continue;
          const t = nonNegative(candle.t);
          const c = nonNegative(candle.c);
          if (t === null || c === null || t > now) continue;
          rows.push({ t, c });
        } catch (err) {
          // Ignore one malformed candle without losing usable history.
        }
      }
      rows.sort((a, b) => a.t - b.t);
      if (!rows.length) return result;
      const latest = rows[rows.length - 1];
      for (const [minutes, field] of [
        [1, 'changePct1m'],
        [5, 'changePct5m'],
        [15, 'changePct15m']
      ]) {
        const cutoff = latest.t - minutes * 60 * 1000;
        let baseline = null;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].t <= cutoff) {
            baseline = rows[i];
            break;
          }
        }
        if (!baseline || baseline.c <= 0) continue;
        const pct = (latest.c - baseline.c) / baseline.c * 100;
        if (Number.isFinite(pct)) result[field] = pct;
      }
      return result;
    } catch (err) {
      return result;
    }
  };

  return { build, flow, priceChanges };
})();
