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

  // Server timestamps are "YYYY-MM-DD HH:MM:SS" in UTC.
  const parseTs = (s) => {
    const t = new Date(`${String(s).replace(' ', 'T')}Z`).getTime();
    return Number.isNaN(t) ? null : t;
  };

  // Pure: which recent sells in this trade list are a dev sell or a whale sell.
  const detect = (trades, { creatorAddr, whaleSellUsd, now, windowMs }) => {
    const dev = creatorAddr ? String(creatorAddr).toLowerCase() : null;
    const out = [];
    for (const t of Array.isArray(trades) ? trades : []) {
      if (!t || t.is_buy !== false) continue; // sells only
      const ts = parseTs(t.timestamp);
      if (ts !== null && windowMs && now - ts > windowMs) continue; // too old
      const vol = Number(t.volume_usd);
      const volumeUsd = Number.isFinite(vol) && vol >= 0 ? vol : 0;
      const trader = typeof t.trader_full === 'string' ? t.trader_full : '';
      if (dev && trader.toLowerCase() === dev) {
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
        dedupe: { key: `dump:${hit.txHash}` },
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
      if (!settings.dumpAlertsEnabled) return;
      const positions = await BBD.store.get(BBD.KEYS.positions, {});
      const addrs = Object.keys(positions).slice(0, MAX_POSITIONS);
      if (!addrs.length) return;
      const now = Date.now();
      const windowMs = settings.dumpWindowMin * 60 * 1000;
      if (seen.size > MAX_SEEN) seen.clear();
      for (const addr of addrs) {
        let trades;
        try {
          const res = await fetch(`/api/token/${addr}/trades`, { credentials: 'same-origin' });
          if (!res.ok) continue;
          const json = await res.json();
          trades = json && json.data;
        } catch (e) {
          continue; // endpoint hiccup — try again next tick
        }
        const hits = detect(trades, {
          creatorAddr: BBD.feed.creatorFor(addr),
          whaleSellUsd: settings.whaleSellUsd,
          now,
          windowMs
        });
        for (const hit of hits) {
          if (!hit.txHash || seen.has(hit.txHash)) continue;
          seen.add(hit.txHash);
          notify(positions[addr], hit);
        }
      }
    } catch (err) {
      console.warn('[bbd] dump tick failed', err);
    }
  };

  return { detect, tick };
})();
