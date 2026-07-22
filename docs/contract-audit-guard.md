# Contract / hook audit guard

Flags tokens whose **contract or Uniswap-v4 hook can steal funds** — the owner
can drain pool liquidity, trap LPs, or levy hidden fees. This is the strongest
rug signal available and one no holder stat exposes: a token can show a clean
top-10 / dev / sniper spread and still have a hook that lets the deployer empty
the pool on demand.

## Data flow

`/api/audit/batch` streams one audit object per token (NDJSON-style, ending with
`{done:true}`):

```
{ chain, address, data: { audit: {
    isTokenSafe, isHookSafe, ownerRenounced, creatorAddress, marketCap, liquidity,
    hookAudit: { isSafe, vulnerabilities: [ { type, impact, severity, description } ] }
} } }
```

- `interceptor.js` reads the response as **text** (not `.json()` — the body is
  many objects) and `parseJsonStream()` extracts each balanced top-level object
  (brace-depth scan, string-aware), then posts the array to the isolated world.
- `feed.js` `evalAudit()` reduces each to a verdict and caches it by address;
  `BBD.feed.auditFor(addr)` returns `{ danger, critical, ownerRenounced, reasons, ts }`.

## Danger rule

```
danger = isTokenSafe === false
      || (hookAudit.isSafe === false && any hookAudit vulnerability is "critical")
```

Hook **warnings** alone don't trip it — only a critical hook vulnerability
(liquidity drain / trade restriction / uncapped hidden fee) or an outright
unsafe token contract. `reasons` carries the human-readable descriptions.

## Effects of a flag

- **Pulse card:** `bbd-danger` class — red outline + `⛔ risky contract` marker.
  A heavier score penalty than the creator guard (`AUDIT_DANGER_PENALTY = -5`,
  funds-at-risk) and 🔥 is blocked outright.
- **Token page:** the `#bbd-intel` chip appends `⛔ <reason>` and goes red.
- Gated behind `auditGuardEnabled` (popup: "Flag risky contracts").

## Note

Verified against the real captured audit for token CHIPS, whose hook lets the
owner drain the pool (`LiquidityDrain`, severity 90) — correctly flagged danger.
Also enables `BBD.feed.ethPrice()` / `priceOf()` from `/api/prices`, groundwork
for USD-denominated features (e.g. a future position-size guard).
