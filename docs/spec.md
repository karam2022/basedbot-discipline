# basedbot-discipline — design spec v1.9 (2026-07-22)

Chrome extension (Manifest V3) for basedbot.app. Core jobs:

## 1. Meme filter (Pulse pages only)
- Runs only on `/pulse/*` routes.
- Each Pulse card is an `<a href="/token/...">`. Badges are `<img alt>` values after the
  token logo (verified live: `Pons`, `Virtual`, `bow.fun`, `Flap`, `Circus`, `Charms`,
  `Bankr`, `Long.xyz`, `Uniswap V2/V3/V4`).
- Hide rule order: per-token override → badge in meme-badge list → keyword match on
  symbol/name → show.
- Defaults: hide `Pons, bow.fun, Flap, Circus, Charms, Long.xyz, Bankr`; keep `Virtual`
  and plain DEX listings. Keyword list catches meme-named leftovers.
- Hidden cards collapse; a floating chip shows "N hidden" and toggles peek mode.
  In peek mode each card gets a hide/keep override button.
- MutationObserver (debounced) handles the live-updating feed; a 1s URL poll handles
  SPA route changes.

## 2. Position discipline (all basedbot pages)
- Data sources (verified live):
  - Token page panel: `Bought / Sold / Holding / Unrealized PnL`.
  - Portfolio positions table: `Token / Amount / MC / Value / PnL` header.
- Primary source is the tapped balances API. Positions are keyed by
  chain/wallet/token and serialized through the service worker; fresh visible
  DOM data is a fallback.
- Banner logic (every basedbot page): any cached position with pct ≥ threshold
  (default +20%) shows a persistent top banner. Snooze (default 15 min) or Dismiss
  per position; dismissed positions re-fire when pct climbs another 10 points.
  Cache older than 30 min is labeled stale.
- Optional Chrome notification on first threshold crossing.
- Independent stop-loss and peak give-back warnings.

## 3. Local journal and anti-FOMO

- Immutable trade ID per position lifecycle; repeated trades never overwrite.
- Stale exit samples remain unknown and cannot trigger a loss/revenge warning.
- Daily-loss overlay plus dismissible revenge warning only while re-holding.

## 4. Proactive risk alerts

- Creator history and contract/hook audit flags.
- Rotating held-position dump monitoring with adaptive liquidity threshold.
- Reliable Chrome/Telegram delivery; dedupe is committed after success.

## Components
- `manifest.json` — MV3, content scripts on `https://basedbot.app/*`, storage +
  notifications permissions.
- `src/constants.js` `src/store.js` `src/filter.js` `src/pnl.js` `src/banner.js`
  `src/main.js` — content scripts, shared scope, each <200 lines.
- `styles.css` — injected styles.
- `popup.html` / `popup.js` — settings (toggles, threshold, snooze, badges, keywords,
  overrides).
- `background.js` — notification relay.

## Out of scope
Auto-selling, external price APIs, non-basedbot sites, non-Pulse filtering.
