# Portfolio PnL from the balances API (#5)

Replaces the fragile DOM scraping in `pnl.js` (which read the portfolio table by
column index and the token-page "Unrealized PnL" block) with the authoritative
`/api/v1/balances` payload.

## Data flow

- `interceptor.js` taps `/api/v1/balances` and posts `data` (the wallet array).
- `feed.js` `takeBalances()` flattens every wallet's `tokens[]` into a held-
  position map keyed by `chain|wallet|address`:

  ```
  token row: { token, symbol, valueUsd, pnl: { relative(%), absolute($) }, pool: { chain } }
        ->   { addr, wallet, chain, symbol, pct: pnl.relative,
               pnlUsd: pnl.absolute, valueUsd, sourceTs }
  ```

  `hasBalances()` flips true on the first tapped fetch; `heldPositions()` returns
  the current holdings.
- `pnl.js` sends complete snapshots to the MV3 service worker. The worker is the
  single writer and rejects older timestamps, so a stale open tab cannot replace
  newer positions from another tab. Accepted snapshots are reconciled into the
  immutable journal.

An API snapshot is authoritative for two minutes. After that it is never
re-timestamped; visible token/portfolio DOM data may act as a fallback until a
new response arrives. Action alerts stop when their position sample exceeds the
stale limit. The popup reports source, age and tracked count.

## Why this is better

- **Accurate open PnL**: `pnl.relative` is the real unrealized PnL %, not a value
  parsed out of a table cell whose column could move.
- **Whole wallet at once**: every position, not just the one whose page you're
  viewing — so the banner and dump alerts see all holdings immediately.
- **No column-index fragility**: the original risk (a new column shifting the
  parse) is gone.

Automated regression coverage includes chain/wallet identity, immutable repeated
trades, stale exit samples and stale-tab snapshot rejection.
