# Portfolio PnL from the balances API (#5)

Replaces the fragile DOM scraping in `pnl.js` (which read the portfolio table by
column index and the token-page "Unrealized PnL" block) with the authoritative
`/api/v1/balances` payload.

## Data flow

- `interceptor.js` taps `/api/v1/balances` and posts `data` (the wallet array).
- `feed.js` `takeBalances()` flattens every wallet's `tokens[]` into a held-
  position map keyed by address:

  ```
  token row: { token, symbol, valueUsd, pnl: { relative(%), absolute($) }, pool: { chain } }
        ->   { symbol, pct: pnl.relative, usd: valueUsd, chain: pool.chain.toLowerCase(), ts }
  ```

  `hasBalances()` flips true on the first tapped fetch; `heldPositions()` returns
  the current holdings.
- `pnl.js` `scanBalances()` reconciles the `positions` store to it — upsert every
  held token, `clearPosition()` anything no longer held (an **empty** holdings
  list means everything was sold). It's routed through `savePosition` /
  `clearPosition`, so the journal open/close lifecycle still fires and the
  take-profit / stop-loss banner and dump alerts keep working unchanged.

DOM scraping (`scanTokenPage` / `scanPortfolio`) stays as the fallback used only
until the app's first balances fetch is tapped — after that, balances is
authoritative (`hasBalances()` gates the switch).

## Why this is better

- **Accurate PnL**: `pnl.relative` is the real unrealized PnL %, not a value
  parsed out of a table cell whose column could move.
- **Whole wallet at once**: every position, not just the one whose page you're
  viewing — so the banner and dump alerts see all holdings immediately.
- **No column-index fragility**: the original risk (a new column shifting the
  parse) is gone.

Verified end-to-end against the real captured ROBI balances rows (buy → position
with pct −2.12% and $0.1893 value → sell → cleared, journal open/close firing,
junk rows skipped): 16/16.
