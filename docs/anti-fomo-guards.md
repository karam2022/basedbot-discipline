# Anti-FOMO guards

Behavioral brakes driven entirely by the trade journal — no new scraping or API
endpoints. Gated behind `fomoGuardEnabled`.

## Daily loss limit

`guard.lossesToday(journal)` counts trades **closed today** with `exitPct < 0`.
Once that reaches `dailyLossLimit` (default 3), a fixed "step away" overlay
(`#bbd-fomo`) appears on every basedbot page. "Dismiss for today" records the
date in the `daystats` key (`lossDismissedDay`) so it stays gone until tomorrow;
`store.pruneAll` clears a stale day's dismissal.

## Revenge trade

On a token page, `guard.recentLoss(entry, revengeWindowMin)` checks the journal
entry for that token: if you closed it at a loss within `revengeWindowMin`
(default 60) minutes, a warning (`#bbd-guard-revenge`) reminds you that you just
sold it in the red — thesis or FOMO?

## Not included: position-size guard

The originally-scoped "buy is X% of pool liquidity / portfolio" warning needs to
read the live buy-panel amount from the DOM and (for the portfolio variant) the
`/api/v1/balances` payload. The buy-panel reading couldn't be verified against a
live page during development, and shipping untested DOM scraping is exactly the
"silently wrong" failure the API-first refactor set out to avoid — so it is
deferred rather than guessed. See the balances tap needed for portfolio-based
sizing (same dependency as the DOM→API PnL migration).
