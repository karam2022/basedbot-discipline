# Dump alerts (#8)

Pings you when someone dumps a token **you hold** — the creator selling ("dev is
dumping your bag") or a single sell over `whaleSellUsd`. Proactive: it polls the
trade feed of each held position, so it fires even when you're not looking at
that chart.

## Why REST, not the WebSocket

The live price/swap stream on basedbot flows through a Web Worker (the chart is
TradingView), and the only main-thread signals are `[PerfDiag]` telemetry
(batch sizes, timings — no prices or swap amounts). So the WebSocket path isn't
reliably tappable. The REST endpoint `/api/token/{addr}/trades` carries the
actual trades and is same-origin, so `src/dump.js` fetches it directly.

## How it works

- `main.js` runs `dump.tick()` every 20 s.
- For each held position (from the `positions` store, capped at 8), it fetches
  `/api/token/{addr}/trades` and runs `detect()`.
- `detect(trades, { creatorAddr, whaleSellUsd, now, windowMs })` returns the
  recent **sells** (`is_buy === false`, within `dumpWindowMin`) that are either
  a **dev sell** (`trader_full === creatorAddr`, from `BBD.feed.creatorFor`) or a
  **whale sell** (`volume_usd >= whaleSellUsd`).
- Each hit alerts once (deduped by `tx_hash`; the recency window means a reload
  never re-alerts old dumps) via the background worker → Chrome notification +
  Telegram.

Trade shape used (per row): `trader_full`, `is_buy`, `volume_usd`, `timestamp`
(UTC `YYYY-MM-DD HH:MM:SS`), `tx_hash`.

## Settings (popup)

- `dumpAlertsEnabled` — master toggle ("Dump alerts").
- `whaleSellUsd` — single-sell USD threshold (default 300).
- `dumpWindowMin` — only trades this recent count (default 3).

## Not included

- **Instant live price → instant take-profit**: dropped. The price stream is
  worker-sourced (see above) and the existing 5 s poll is already fast; the
  marginal gain didn't justify an unverifiable WebSocket/worker tap.
- Dev detection needs `creatorAddr`, which comes from the feed cache
  (`creatorFor`); if you've never seen the token in the feed, only whale
  detection runs for it.

Verified against the real captured `/trades` response (whale threshold, dev
match, buy/stale exclusion): 11/11.
