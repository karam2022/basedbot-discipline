# Creator reputation (dev guard)

Flags tokens whose creator is a serial launcher or a repeat rugger, so a
known-bad dev is obvious on sight instead of hiding behind a clean-looking
holder snapshot. This is only possible because of the API tap
(`src/interceptor.js` / `src/feed.js`): a single Pulse card never exposes the
creator address or the fate of the dev's other tokens.

## Data flow

1. `interceptor.js` (MAIN world) taps three endpoints and posts them to the
   isolated world:
   - `/api/tokens/metrics/batch` → carries `creatorAddress` per token
   - `/api/tokens` (feed list) → carries `market_cap_usd` + `liquidity_usd`
   - `/api/tokens/metadata*` → social links (unrelated; pre-existing)
2. `feed.js` caches `creatorFor(addr)` and `marketFor(addr)` (last-seen market).
3. `creator.js` joins them: every card scanned during `filter.scan()` (and every
   token page in `intel.js`) calls `observe(addr, creatorFor(addr), marketFor(addr))`,
   building a per-creator history in memory.
4. Persistence: the model flushes to `chrome.storage.local` under the `creators`
   key every 30 s and on `pagehide`, and hydrates on load. `store.pruneAll`
   keeps 30 days / 2000 creators.

## Reputation model

```
creators: {
  [creatorAddr]: {
    tokens: {
      [tokenAddr]: { symbol, firstTs, lastTs, peakMcap, lastLiq, lastMcap }
    },
    ts
  }
}
```

Rug status is **not stored** — it is recomputed from the raw market history
against current settings, so tightening a threshold reclassifies past tokens
without a migration. A token is a rug when it once had a real market and later
lost its liquidity:

```
isRug(t) = t.peakMcap >= creatorRugMinPeakUsd     (default 8000)
        && t.lastLiq  <  creatorRugDeadLiqUsd      (default 800)
```

A creator is **flagged** when:

```
launchCount >= creatorMaxLaunches   (default 5)   // serial launcher
|| ruggedCount >= creatorMaxRugs     (default 2)   // repeat rugger
```

## Effects of a flag

- **Pulse card:** gets the `bbd-baddev` class — amber outline + `⚠️ dev` marker.
  It stays visible (a held or user-kept token is never silently hidden), but the
  creator penalty (`BAD_CREATOR_PENALTY = -3`) is added to its utility score, so
  a borderline token tips toward hidden.
- **🔥 best-guess:** a flagged creator can never earn 🔥, regardless of how clean
  the holder snapshot looks — ruggers optimize exactly that snapshot.
- **Token page:** the `#bbd-intel` chip appends `👤 dev: N launches, M rugged ⚠️`
  and is forced red.

## Settings (popup)

- `creatorGuardEnabled` — master toggle
- `creatorMaxLaunches`, `creatorMaxRugs` — the two flag thresholds
- `creatorRugMinPeakUsd`, `creatorRugDeadLiqUsd` — rug-detection tuning (defaults
  only; not surfaced in the popup to keep it uncluttered)

## Limitations

- Reputation is **learned from what you browse** — a brand-new dev with no
  history can't be flagged yet. It sharpens over time.
- Rug detection needs to have observed the token both alive (peak) and dead
  (collapsed liquidity); a token that died before you ever saw it won't count.
- The read-modify-write flush merges across tabs but is not atomic; for a
  reputation counter that is acceptable (same trade-off as the rest of the store).
