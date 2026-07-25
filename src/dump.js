// Dump alerts (#8): for every position you hold, watch the token's trade feed
// (/api/token/{addr}/trades) and ping when the creator sells ("dev is dumping
// your bag") or a single sell exceeds whaleSellUsd. Proactive — it polls the
// held tokens, so it fires even when you're not looking at that chart. Only
// trades inside dumpWindowMin count, so a reload never re-alerts old dumps.
'use strict';

BBD.dump = (() => {
  const seen = new Set(); // tx_hash already alerted this session
  const MAX_POSITIONS = 8; // cap active polling
  const MAX_SEEN = 5000;
  const warnedClientErrors = new Set(); // addr already diagnosed this session
  let cursor = 0;

  // Pure: which recent sells in this trade list are a dev sell or a whale sell.
  const detect = (trades, { creatorAddr, whaleSellUsd, now, windowMs }) => {
    const dev = creatorAddr ? String(creatorAddr) : null;
    const sameAddr = (a, b) => {
      if (!a || !b) return false;
      return a.startsWith('0x') && b.startsWith('0x')
        ? a.toLowerCase() === b.toLowerCase()
        : a === b; // base58 addresses are case-sensitive
    };
    const out = [];
    for (const t of Array.isArray(trades) ? trades : []) {
      if (!t || t.is_buy !== false) continue; // sells only
      const ts = BBD.parseTradeTimestamp(t.timestamp);
      if (windowMs && (ts === null || now - ts > windowMs || ts - now > 60 * 1000)) continue;
      const vol = Number(t.volume_usd);
      const volumeUsd = Number.isFinite(vol) && vol >= 0 ? vol : 0;
      const trader = typeof t.trader_full === 'string' ? t.trader_full : '';
      if (dev && sameAddr(trader, dev)) {
        out.push({ kind: 'dev', txHash: t.tx_hash, volumeUsd, trader });
      } else if (volumeUsd >= whaleSellUsd) {
        out.push({ kind: 'whale', txHash: t.tx_hash, volumeUsd, trader });
      }
    }
    return out;
  };

  const notify = (pos, hit) => {
    const sym = BBD.sanitizeAlertText(pos.symbol, 20) || pos.addr.slice(0, 8);
    const usd = `$${Math.round(hit.volumeUsd).toLocaleString('en-US')}`;
    const dev = hit.kind === 'dev';
    try {
      chrome.runtime.sendMessage({
        type: 'bbd-notify',
        dedupe: { key: `dump:${pos.chain || 'unknown'}:${hit.txHash}` },
        title: dev ? `🚨 DEV is selling ${sym}` : `🐋 Whale dumped ${sym}`,
        message: dev
          ? `The creator just sold ${usd} of ${sym} — your bag may be next.`
          : `A single ${usd} sell just hit ${sym}.`,
        url: pos.chain ? `${location.origin}/token/${pos.chain}/${pos.addr}` : undefined
      });
    } catch (err) {
      console.warn('[bbd] dump alert failed', err);
    }
  };

  const tick = async () => {
    try {
      const settings = await BBD.store.settings();
      // The poll feeds both dev/whale detection and the AI exit-timing alarm;
      // run it if either wants it, then each gates its own action below.
      if (!settings.dumpAlertsEnabled && !settings.exitAlarmEnabled) return;
      const positions = await BBD.store.get(BBD.KEYS.positions, {});
      const all = Object.entries(positions).map(([positionKey, p]) => ({
        positionKey, ...p, addr: BBD.positionAddr(positionKey, p)
      })).filter((p) => p.addr && typeof p.sourceTs === 'number' &&
        Date.now() - p.sourceTs <= BBD.STALE_MS);
      if (!all.length) return;
      const selected = Array.from({ length: Math.min(MAX_POSITIONS, all.length) },
        (_, i) => all[(cursor + i) % all.length]);
      cursor = (cursor + selected.length) % all.length;
      const now = Date.now();
      const windowMs = settings.dumpWindowMin * 60 * 1000;
      if (seen.size > MAX_SEEN) seen.clear();
      for (const pos of selected) {
        const addr = pos.addr;
        const pool = BBD.feed.poolFor(addr);
        if (!pool || !pool.pool) continue;
        const params = new URLSearchParams();
        const chain = pool.chain || pos.chain;
        if (chain) params.set('chain', chain);
        params.set('pool', pool.pool);
        let trades;
        try {
          const res = await fetch(`/api/token/${addr}/trades?${params}`, {
            credentials: 'same-origin'
          });
          if (!res.ok) {
            const failureKey = addr.startsWith('0x') ? addr.toLowerCase() : addr;
            if (res.status >= 400 && res.status < 500 && !warnedClientErrors.has(failureKey)) {
              warnedClientErrors.add(failureKey);
              console.warn(`[bbd] dump trades request failed for ${addr}: ${res.status}`);
            }
            continue;
          }
          const json = await res.json();
          trades = json && json.data;
        } catch (e) {
          continue; // endpoint hiccup — try again next tick
        }
        // This poll is the freshest price we get for held tokens (the live swap
        // socket is unreachable — see feed.notePrice) — feed the tick cache.
        BBD.feed.notePrice(addr, trades);
        BBD.feed.noteTrades(addr, trades);
        // Dev/whale detection is gated by its own master switch, so the
        // AI exit-timing alarm can share this poll even when it's off.
        if (settings.dumpAlertsEnabled) {
          const market = BBD.feed.marketFor(addr);
          const liquidityThreshold = market && typeof market.liq === 'number'
            ? market.liq * settings.whaleSellLiquidityPct / 100 : 0;
          const hits = detect(trades, {
            creatorAddr: BBD.feed.creatorFor(addr),
            whaleSellUsd: Math.max(settings.whaleSellUsd, liquidityThreshold),
            now,
            windowMs
          });
          for (const hit of hits) {
            if (!hit.txHash || seen.has(hit.txHash)) continue;
            seen.add(hit.txHash);
            notify(pos, hit);
            if (BBD.advisor) BBD.advisor.onDump(pos.addr);
          }
        }
        if (BBD.exitAlarm) BBD.exitAlarm.check(pos, trades, settings);
      }
    } catch (err) {
      console.warn('[bbd] dump tick failed', err);
    }
  };

  return { detect, tick };
})();
