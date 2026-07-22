# Trade journal

Turns the position tracker into a behavior mirror: it records every position's
lifecycle and shows, in the popup, your win rate, average realized PnL, and —
the discipline metric — how much peak profit you gave back by not taking it.

## Data flow

Driven entirely by the existing PnL lifecycle in `src/pnl.js`:

- `savePosition()` (every observation of a held position) → `journal.onHeld()`
- `clearPosition()` (holding went to zero) → `journal.onClosed()`

No new scraping — the journal rides the same signal the take-profit/stop-loss
banner already reads.

## Schema (`journal` storage key)

```
journal: {
  [addr]: {
    symbol, chain,
    openTs, closeTs,
    entryVerdict: { devFlagged, devLaunches, statsKnown },  // snapshot at entry
    peakPct,      // max PnL% seen while held
    lastPct,      // most recent PnL%
    exitPct,      // realized PnL% at close (= lastPct when closed)
    status: 'open' | 'closed'
  }
}
```

`entryVerdict` is captured **once at open** and never overwritten — it freezes
what was known about the token's creator and safety the moment you bought.
`peakPct` climbs; `lastPct` tracks the current value; buying the same token
again after a close starts a fresh entry. `store.pruneAll` keeps 90 days / 1000
trades, timestamped by close (or open while still running).

## Summary metrics (popup)

- **Win rate** — closed trades with `exitPct > 0`.
- **Avg realized** — mean `exitPct` over closed trades.
- **Avg profit given back** — mean `peakPct − exitPct` over trades that were
  ever green. High values mean you rode winners past the exit; this is the
  number the take-profit banner exists to shrink.
- **Flagged-dev buys** — how many closed trades were opened while the creator
  guard had the dev flagged, and what share of those lost. Answers "do I keep
  buying from known ruggers, and does it cost me?"

`BBD.journal.summarize()` computes these for content scripts; `popup.js` carries
an identical standalone copy (the popup can't see the content-script `BBD`
namespace — keep the two in sync).
