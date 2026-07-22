# Anti-FOMO guards

Behavioral brakes driven entirely by the trade journal — no new scraping or API
endpoints. Gated behind `fomoGuardEnabled`.

## Daily loss limit

`guard.lossesToday(journal)` counts trades **closed today** with a fresh,
estimated `exitPct < 0`. Stale/unknown exits are excluded.
Once that reaches `dailyLossLimit` (default 3), a fixed "step away" overlay
(`#bbd-fomo`) appears on every basedbot page. "Dismiss for today" records the
date in the `daystats` key (`lossDismissedDay`) so it stays gone until tomorrow;
`store.pruneAll` clears a stale day's dismissal.

## Revenge trade

On a token page, the guard finds the latest closed trade for that wallet/chain/
token. It warns only when the token is currently held again and the last fresh
exit estimate was negative within `revengeWindowMin` (default 60 minutes).
Simply viewing a sold token does not warn. The advisory has a **Dismiss** button;
its trade ID is stored in `guardDismissed` so it stays closed.

## Not included: position-size guard

The originally-scoped "buy is X% of pool liquidity / portfolio" warning needs to
read the live buy-panel amount from the DOM and (for the portfolio variant) the
`/api/v1/balances` payload. The buy-panel reading couldn't be verified against a
live page during development, and shipping untested DOM scraping is exactly the
"silently wrong" failure the API-first refactor set out to avoid — so it is
deferred rather than guessed. See the balances tap needed for portfolio-based
sizing (same dependency as the DOM→API PnL migration).
