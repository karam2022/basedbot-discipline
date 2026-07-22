# Trade journal (v2)

The journal stores an immutable entry for every position open/close cycle. A
second trade of the same token creates a new trade ID instead of overwriting the
first trade.

## Identity and schema

Positions use `chain|wallet|token` identity. Journal entries use
`{positionKey}@{openTimestamp}`:

```
journal: {
  [tradeId]: {
    tradeId, positionKey, addr, wallet, chain, symbol,
    openTs, lastSeenTs, closeTs,
    entryVerdict: { devFlagged, devLaunches, statsKnown },
    peakPct, lastPct,
    exitPct,          // last fresh estimate, or null
    exitEstimatePct,  // retained for diagnosis even when stale
    exitEstimated: true,
    exitSampleAgeMs,
    status: 'open' | 'closed'
  }
}
```

Address-keyed v1 entries are migrated in memory and persisted in v2 form on the
next write.

## Exit accuracy

The balances API reports unrealized PnL while a position is open; it does not
provide the exact realized fill in the captured payload. Therefore the journal
does not call the last sample an exact realized result:

- When the last sample is at most `exitSampleMaxAgeSec` old (default 60 s), it
  is stored as an estimated `exitPct`.
- An older value is stored only as `exitEstimatePct`; `exitPct` is `null`.
- Unknown/stale exits do not count as wins/losses and cannot trigger revenge
  mode. This prevents a stale negative value from misclassifying a quick
  profitable exit.

## Summary and export

The popup shows tracked closes, win rate, average estimated exit and peak
give-back. Closures without a fresh exit sample are listed separately. The
complete JSON journal can be exported before clearing it.
