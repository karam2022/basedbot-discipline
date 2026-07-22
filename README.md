# BasedBot Discipline

A Chrome extension for [basedbot.app](https://basedbot.app) that adds a local
discipline and risk layer:

1. **Cleans and risk-ranks Pulse** — hides noise, explains failed safety checks,
   and flags risky contracts and repeat-offender creators.
2. **Monitors positions** — take-profit, stop-loss, peak give-back and dump alerts.
3. **Records trade cycles** — immutable local journal, even when the same token
   is bought repeatedly.
4. **Interrupts bad loops** — daily loss limit and a dismissible revenge-buy warning.

No auto-trading. It never touches the buy or sell button. It reads what's on
the page and tells you what it sees. Nothing leaves your browser except the
Telegram messages you configure yourself.

---

## Quickstart (2 minutes)

1. Download and unzip this folder anywhere permanent (don't delete it later —
   Chrome loads the extension from this folder).
2. Open `chrome://extensions` in Chrome.
3. Turn ON **Developer mode** (toggle, top right).
4. Click **Load unpacked** → select the unzipped folder.
5. Open basedbot.app → Pulse. You should see an orange chip bottom-right:
   "🚫 N memecoins hidden". Done.

Settings live in the extension's toolbar popup (click the green circle icon).

---

## What each feature does

### 🚫 The meme filter (Pulse pages)

Every card on Pulse gets scored. Tokens are hidden only when:
- the name/ticker is a meme (pepe, inu, bonk, wif...), or
- the token has no website AND weak on-chain structure.

**Anything with a real web presence (website, GitHub, docs, Discord) is never
auto-hidden.** The filter kills spam, not your judgment.

- The orange chip (bottom-right) shows the hidden count. Click it to peek —
  hidden cards reappear with an orange dashed outline.
- Hover any card for a 🚫 button (always hide this token) or, while peeking,
  ✓ keep (always show it). Your overrides are permanent per token and listed
  in the popup.

### 🔥 Best guess and 💎 gem highlights

Cards carry basedbot's own safety stats (see the glossary below). The
extension reads them and marks:

- **🔥 BEST GUESS** (pulsing green ring + ribbon): passes EVERY safety gate
  AND shows real utility evidence (website plus docs/GitHub/agent-platform
  signals). Meme-named tokens can never be 🔥, however clean their stats.
- **💎** (gold ring): strong utility score but not the full safety sweep, or
  safe with thinner utility proof. Worth a look, not a verdict.

### 🛡 Token Info verdict chip (token pages)

Open any token page and the extension reads the Token Info panel for you:
Top-10 concentration, dev holdings, snipers, insiders, bundlers, Dex Paid,
LP burned/locked, renounced. A chip (bottom-left) shows
`🛡 7/8 checks · ⚠️ what failed`. Green = clean, amber = 1–2 warnings,
red = walk away.

### 🟢 The take-profit banner

Whenever you're on a token page or your Portfolio, the extension reads your
position PnL. Any position above your threshold (default +20%) shows a
persistent green banner on every basedbot page:

> 🟢 TOKEN is +34% — you told yourself you'd take profit.

- **Snooze** silences it for 15 minutes (configurable).
- **Dismiss** silences it until the gain climbs another 10 points, then it
  comes back. It is supposed to be annoying.
- **Peak give-back** warns when a winner falls 15 percentage points from its
  observed peak (configurable).
- **Stop-loss** uses its own independent threshold and keeps working even when
  take-profit reminders are disabled.
- Optional Chrome notification when a position first crosses the threshold —
  the only thing that ever hits your desktop notifications.

A common pattern from profitable traders: treat the banner as "sell half",
not "sell all". Book the gain, keep a core.

Position data carries its original API timestamp. Stale snapshots do not fire
action alerts and the popup shows the current data-source health.

### 📓 Journal and anti-FOMO guard

Each open/close cycle has a separate trade ID keyed by wallet, chain and token.
Buying the same token again no longer overwrites the previous result. Because
BasedBot currently supplies unrealized PnL for open balances, the exit percentage
is explicitly an estimate from the last fresh sample; an old sample is never
counted as a realized loss.

Older v1 journal exits did not contain sample timestamps, so they are migrated
as “closed without fresh exit” instead of being trusted as wins or losses.

The revenge warning appears only if the token is actually held again after a
recent tracked loss. It has a **Dismiss** button. Merely viewing a token after
selling it never triggers the warning.

### 📱 Telegram alerts (optional)

🔥 and 💎 discoveries go to Telegram ONLY (your desktop stays quiet for
those). Take-profit alerts go to both. Setup:

1. In Telegram, message **@BotFather** → `/newbot` → copy the token.
2. Message your new bot once (press Start).
3. Paste the token into the extension popup. The chat ID fills itself in —
   the extension discovers it automatically. (If you want to enter it by
   hand: message **@userinfobot** for your numeric ID.)
4. Click **Send test alert**. Failed deliveries are retried; they are no longer
   marked as sent before Telegram confirms success.

### ↻ Refresh button

Next to the chip. One click forces a full re-scan of everything.

---

## The safety metrics, in plain words

These appear on every Pulse card and in Token Info. The extension's gates in
brackets.

| Metric | What it means | Gate |
|---|---|---|
| **Top 10 H.** | % of supply held by the 10 biggest wallets. High = a dump is pre-loaded. | ≤ 30% |
| **Dev H.** | % the deployer still holds. | ≤ 2% |
| **Snipers H.** | % held by bots that bought in the first blocks. They exit on you. | ≤ 15% |
| **Bundlers** | % bought in coordinated bundles at launch. Coordinated entry = coordinated exit. | ≤ 15% |
| **Insiders** | % held by wallets linked to the team. | ≤ 20% |
| **Holders** | Real traction. Fresh launches with 3 holders can't fake this. | ≥ 100 |
| **Pro traders** | Experienced wallets among holders. 15–30% is smart money arriving; 90% is a bot swarm. | 5–60% |
| **Dex Paid** | Dev paid for the DEX listing profile. Skin in the game. | required |
| **LP Burned/Locked** | Liquidity can't be pulled. The classic rug is impossible. | verdict chip only |
| **Renounced** | Dev gave up contract control. | verdict chip only |

Every threshold is taken from what consistently-profitable on-chain traders
repeat, and from comparing real runners (PONS, The Index, WIRE, Arrow) against
farms that looked identical on the surface.

---

## Settings reference (popup)

| Setting | Default | What it does |
|---|---|---|
| Hide meme coins on Pulse | on | The filter itself |
| 🔥 Best-guess highlight | on | The green ribbon system |
| Take-profit reminders | on | Profit banner only; position tracking is shared and independent |
| Stop-loss / peak give-back | 25% / 15 points | Independent loss and trailing-profit warnings |
| Trade journal / Anti-FOMO | on / on | Per-cycle history, daily loss and revenge-buy guards |
| Dump alerts | on | Dev/whale sells; threshold adapts to pool liquidity |
| Chrome notifications | off | Desktop ping on threshold cross |
| Remind when up | 20% | Take-profit threshold |
| Snooze length | 15 min | Banner snooze |
| Hide below score / gem score | 2 / 4 | Filter strictness (higher = stricter) |
| Meme launchpad badges | Pons, Pump.fun, Zora, Clanker, ... | Which launchpads count against a token's score |
| Meme keywords | pepe, inu, ... | Names that get hidden outright. Edit freely |
| Telegram token / chat ID | empty | See Telegram section |

Advanced settings include **Conservative** and **Balanced** presets; they adjust
discipline/risk thresholds without overwriting Telegram credentials, custom
keywords or per-token overrides.

---

## FAQ

**A token I like is hidden.** Hover its card while peeking and hit ✓ keep.
Permanent. If it happens a lot, lower "Hide below score" to 1 or 0.

**A meme is showing.** Hover → 🚫. Or add its name pattern to the keywords.

**The chip count froze / weird behavior after updating.** After any reload of
the extension in `chrome://extensions`, refresh your basedbot tabs once.

**A revenge warning is wrong or no longer useful.** It now appears only while
you hold the token again and can be dismissed. Exit PnL is never inferred from
a balance sample older than 60 seconds.

**Do 🔥 tokens go up?** Unknowable. 🔥 means the on-chain structure is clean
and there's evidence of a real project — it filters out the 95% that are
structured to dump on you. The remaining risk is the actual market. Nothing
here is financial advice.

**Is my wallet safe?** The extension has no wallet access, no private keys,
no transaction ability. Permissions are: read/change data on basedbot.app,
storage, notifications, and api.telegram.org (only if you configure a bot).
Read the source — it's small and unminified.

**Multi-chain?** Works on every chain basedbot's Pulse supports (Robinhood,
Base, Ethereum, Solana, ...). Launchpad badges for all of them are built in.

---

## Advanced: 24/7 alerts from a server (optional)

The `vps-watcher/` folder contains a standalone Node script that scans Pulse
around the clock from any Linux server and sends 🔥/💎 alerts to Telegram —
laptop off, phone on. It needs no wallet (Pulse is public). See
`vps-watcher/README-DEPLOY.md`. Skip this entirely if you just want the
extension.

---

## Disclaimers, honestly

- Not financial advice. The filter reduces noise; it cannot see the future.
- The extension primarily reads BasedBot's own JSON responses and uses the DOM
  as a fallback. A major API or page redesign can still require an update.
- Memecoin trading on fresh launchpads is a negative-sum knife fight. The
  take-profit banner exists because the house edge is your own greed. Listen
  to it.
