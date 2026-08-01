# Solana-Unterstützung — verifizierte Datenlage

Live geprüft am **2026-08-01** auf `basedbot.app` (Chrome DevTools / MAIN-World-Tap),
auf `/pulse/solana` und der Token-Seite
`/token/sol/63hENiP16MC6qrwD5QdUAfeaAnYm7ovxJu89JVxDpump`.

Kernbefund: **BasedBot bedient Solana aus einem komplett anderen Backend.** Auf
Robinhood/EVM laufen alle Daten über `basedbot.app/api/*`; auf Solana über
`basedbot-api.mobula.io/api/2/*`. `interceptor.js` beobachtet nur die erste
Gruppe — deshalb ist der Feed-Cache auf Solana leer und alles, was darauf
aufbaut (Stats, Audit, Creator, Tape), fällt still aus.

---

## 1. Chain-Identität — vier Schreibweisen für dieselbe Chain

| Kontext | Wert für Solana | Wert für Robinhood |
| --- | --- | --- |
| Pulse-Route | `/pulse/**solana**` | `/pulse/robinhood` |
| Token-Route | `/token/**sol**/{addr}` | `/token/robinhood/{addr}` |
| Numerische Chain-ID (basedbot REST) | `**-1**` | `4663` |
| Mobula-Payload (`chainId`) | `**solana:solana**` | — |

Die REST-API nennt ihre gültigen IDs selbst, wenn man eine ungültige schickt:

```
Invalid chain ID: 0. Valid chain IDs are:
8453, -1, 56, 1, 4217, 5042, 988, 43114, 2741, 4326, 4663,
143, 645749, 42161, 57073, 130, 1514, 9745, 196
```

**`0` ist keine gültige Chain-ID.** `vps-watcher/watcher.mjs` verwendet
`solana: 0` und fällt bei unbekannten Chains via `CHAIN_IDS[chain] || 0` auf
denselben Wert zurück — beide Pfade werden von der API hart abgelehnt.

Konsequenz: Chain-Vergleiche müssen kanonisiert werden. `sol` ≠ `solana` als
String, aber `positionKey`/`positionIsToken` müssen sie als dieselbe Chain
behandeln, sonst gilt ein auf der Token-Seite (`sol`) erfasster Bestand auf der
Pulse-Seite (`solana`) nicht als gehalten.

---

## 2. Endpunkt-Abgleich Robinhood ↔ Solana

| Zweck | Robinhood / EVM | Solana | Status im Code |
| --- | --- | --- | --- |
| Feed-Liste | `GET /api/tokens` | `POST basedbot-api.mobula.io/api/2/pulse` | ✅ getappt |
| Card-Stats | `POST /api/tokens/metrics/batch` | **ebenfalls `api/2/pulse`** | ✅ getappt |
| Metadaten/Socials | `POST /api/tokens/metadata` | **ebenfalls `api/2/pulse`** (`socials`) | ✅ getappt |
| Contract-Audit | `POST /api/audit/batch` | `POST …/api/2/token/security` | ✅ getappt |
| Trade-Tape | `GET /api/token/{a}/trades` | `POST …/api/2/token/trades` | ✅ getappt |
| Creator-Historie | aus `creatorAddress` + Beobachtung | `POST …/api/2/wallet/deployer` | ✅ getappt |
| Holder-Liste | `GET /api/token/{a}/holders?chain` | **identisch, funktioniert** | ✅ nutzbar |
| Positionen | `GET /api/v1/balances` | zusätzlich `GET /api/v1/monitor/{a}?chain=-1` | teilweise |
| Preise | `GET /api/prices` | identisch | ✅ getappt |

### `/api/token/{addr}/trades` ist auf Solana tot

```
?chain=sol&pool=…   → 500 {"data":[],"error":"Error fetching trades"}
?chain=-1&pool=…    → 500 (identisch)
ohne pool           → 400 {"error":"pool parameter is required"}
```

Ersatz ist `…/api/2/token/trades` — dieselben Trades, andere Sprache:

| intern | EVM (`/api/token/{a}/trades`) | Solana (`api/2/token/trades`) |
| --- | --- | --- |
| `ts` | `timestamp` (UTC-String) | `date` (Epoch-ms) |
| `txHash` | `tx_hash` | `transactionHash` |
| `trader` | `trader_full` | `swapSenderAddress` |
| `isBuy` | `is_buy` (bool) | `type` (`"buy"`/`"sell"`) |
| `volumeUsd` | `volume_usd` | `baseTokenAmountUSD` |
| `isPro` / `isSniper` | `is_pro_trader` / `is_sniper` | `labels: []` |
| Preis / MCap | `price_usd` | `baseTokenPriceUSD` / `baseTokenMarketCapUSD` |

Jede Row nennt ihren eigenen Token in `baseToken.address` — die Zuordnung
braucht den POST-Body nicht, den der Tap ohnehin nicht sieht.

⚠️ **Unverifiziert:** In der Stichprobe kam nur `labels: ["proTrader"]` vor.
Ob Snipers dort als `sniper` auftauchen, ist **nicht bestätigt** — der Adapter
matcht defensiv auf Teilstrings, `isSniper` kann auf Solana also dauerhaft
`false` bleiben. Das trifft alles, was auf Sniper-Abfluss reagiert
(`riskfloor.activeHazard`, das Cohort-Readout).

Zweite Einschränkung: die Rows kommen **nur als Tap der seiteneigenen
Anfrage**. Ein gehaltener Solana-Token wird also nur überwacht, solange seine
Seite offen ist — `dump.js` kann ihn im Hintergrund nicht pollen.

### `/api/token/{addr}/holders?chain=sol` funktioniert

Liefert `rank, address, token_amount, percentage, total_pnl_usd, …` — also
genau das, was `holders.js` erwartet. Auf Solana hält der Bonding-Curve-Pool
selbst Rang 1 (im Beispiel 85 %); das muss beim Konzentrations-Readout
ausgenommen werden, sonst liest jede pump.fun-Kurve als Extremkonzentration.

---

## 3. `api/2/token/security` — die Solana-Sicherheitsquelle

Eine Antwort ersetzt `metrics/batch` **und** `audit/batch`:

```json
{ "address": "63hEN…pump", "chainId": "solana:solana",
  "top10HoldingsPercentage": 14.65, "top50HoldingsPercentage": 14.65,
  "buyFeePercentage": 0, "sellFeePercentage": 0, "transferFeePercentage": 0,
  "isMintable": false, "isFreezable": false, "transferPausable": false,
  "isBlacklisted": false, "isHoneypot": null, "isLaunchpadToken": true,
  "burnedHoldingsPercentage": null, "contractHoldingsPercentage": null,
  "renounced": null, "locked": null, "lowLiquidity": "true",
  "proTraderVolume24hPercentage": 197.95 }
```

Wichtig: `isMintable` (Mint-Authority) und `isFreezable` (Freeze-Authority)
sind die **Solana-Entsprechung des Honeypot-Checks** — eine aktive
Freeze-Authority kann den Verkauf blockieren, eine aktive Mint-Authority die
Supply beliebig verwässern. Auf EVM existieren beide nicht; dafür sind dort
`renounced`/`locked` gesetzt, die auf Solana `null` bleiben.

Die Tax kommt hier als `buyFeePercentage`/`sellFeePercentage` — auf der
Token-Seite steht auf Solana **keine** `Tax B/S`-Zeile.

---

## 4. Token-Seite: Panel identisch, zwei Felder leer

Das „Token Info"-Panel hat auf Solana **exakt dieselben Labels** wie auf
Robinhood, in derselben Reihenfolge (Wert steht vor dem Label):

```
15% Top 10 H. · 1% Dev H. · 0% Snipers H. · 0% Insiders · 0% Bundlers
—   Renounced · 100% LP Burned · 0% LP Locked · 0.0% Token Burn
6   Holders   · 2 Pro Traders · Unpaid Dex Paid · 0.080 Fees Paid
```

- `Renounced` ist auf Solana immer `—` → `intel.js` liefert korrekt `null`.
- Eine `Tax B/S`-Zeile gibt es nicht → `parseTax()` liefert korrekt `null`.
- `LP Burned` **funktioniert** (hier 100 %).

`intel.js` arbeitet auf Solana also bereits — mit 8 statt 10 Checks. Das Panel
rendert nach dem Klick verzögert; der erste `scan()` läuft ins Leere und erst
der Poll greift.

Zusätzlich blendet die Seite `POOL` und `DEV` als Kurzadressen ein, und die
Tabs nennen `Holders(6)` / `Dev Tokens(50)` — letzteres ist die
Creator-Reputation direkt an der Quelle.

---

## 5. Pulse-Feed: gleiche Karten, andere Hülle

- **Keine `<table>`.** Auf Robinhood ist der Feed eine echte Tabelle
  (`tbody tr`); auf Solana sind die Karten direkte `<a href="/token/sol/…">`
  in einem Scroll-Container. `filter.js` findet die Karten trotzdem (es
  selektiert über den `href`, nicht über die Tabelle).
- **Die Chips sind identisch**, inklusive SVG-Pfad-Fingerprints
  (`M2 22C2 17.58…` Holders, `M3.0585 12.6006…` Pro Traders,
  `M4.6665 4.0833…` Top10, `M3.50021 8.0911…` Dev, `M6.41647 12.804…`
  Snipers) — dieselben Werte wie in `webseiten-analyse.md` für Robinhood.
- **`?%`-Platzhalter.** Frische Solana-Karten zeigen `?%` statt einer Zahl.
  Von 90 Karten hatten nur 4 vollständige Werte. `parseCardStats` verlangt
  ≥ 5 Treffer auf `/^<?\d+(\.\d+)?%$/` und gibt sonst `null` zurück — auf
  Solana also für ~95 % der Karten gar keine Stats.

Beispielkarte (Leaf-Text):

```
1m | DNLD | DONALD | /SOL | V | $2.7K | MC | $870.44 | 1m | Pump.fun |
F | $0.13 | TX | 28 | 5 | 1 | 34% | 34% | 34% | 0% | 0% | No | Buy 0.1
```

Die Positionslogik (`holders`, `pro`, dann 5 Prozentwerte, dann Dex-Paid)
stimmt auch hier — sie scheitert nur an den `?%`.

---

## 6. Umsetzungsstand

**Erledigt**

- `src/chain.js` — kanonische Chain-Identität. `sol`, `solana`, `-1` und
  `solana:solana` lösen auf denselben Schlüssel auf; `numericId()` liefert die
  vom API akzeptierte Zahl oder `null` (nie eine erfundene). Dazu eine
  Capability-Matrix, die „gibt es auf dieser Chain nicht" von „unbekannt"
  trennt.
- `positionKey`/`positionIsToken`/`isHeld` vergleichen kanonisch — ein auf
  `/token/sol/…` erfasster Bestand gilt jetzt auch auf `/pulse/solana`.
- `interceptor.js` tappt `api/2/token/security` und `api/v1/monitor/{addr}`,
  jeweils host-gebunden.
- `feed.js` — `takeSecurity()` erzeugt aus dem Security-Block ein
  Audit-Verdikt (Freeze-Authority/Honeypot/Blacklist/Pausable = kritisch,
  Mint-Authority = gefährlich) und cached Tax + Authorities unter
  `securityFor()`. `takeMonitor()` liefert die Pool-ID.
- `parseCardStats` behandelt `?%` als unbekannt statt die ganze Karte zu
  verwerfen; `statBonus`/`isHot` zählen unbekannte Werte nicht mehr als
  bestanden (vorher: `null <= n` ist `true` — eine ungeladene Karte bestand
  jede Prüfung auf einmal).
- `vps-watcher/watcher.mjs` — korrekte Chain-IDs, unbekannte Chain überspringt
  die Anreicherung statt eine abgelehnte `0` zu senden.

- **Tape.** `interceptor.js` tappt `api/2/token/trades`; `feed.js:tradeRow()`
  normalisiert beide Vokabulare auf eine Zeilenform, `candles.js:svmTrade()`
  liest die Rohzeilen direkt. `price.js`, `dump.js` und `advisor.js`
  überspringen auf `family === 'svm'` den toten REST-Call und lesen die
  getappten Rows. Der Tape liefert dort auch den Preis-Tick (`baseTokenPriceUSD`
  / `baseTokenMarketCapUSD`), weil es sonst keine Preisquelle gibt.

- **Pulse-Feed.** `takePulse()` liest alle drei Buckets und füllt Stats,
  Market, Pool, Socials **und** die Creator-Adresse aus einer einzigen
  Nutzlast. Der Interceptor projiziert sie vorher im MAIN-World auf 21 Felder:
  live gemessen **3,2 MB → 234 KB** (−93 %), was den Replay-Puffer und das
  Structured-Cloning erst tragbar macht.
- **Creator-Historie.** `takeDeployer()` speichert `pagination.total` als
  autoritative Launch-Zahl; `creator.noteDeployer()` schickt die Token-Zeilen
  durch das bestehende `observe()`, sodass die Rug-Erkennung unverändert gilt.
  `reputation()` nimmt `max(beobachtet, gemeldet)` — Beobachtung kann nur
  unterzählen. Die Zuordnung läuft über den offenen Token, weil der Tap den
  POST-Body nicht sieht.

**Offen**

- `isSniper` auf Solana: siehe Warnung in §2 — `labels` muss über eine größere
  Stichprobe geprüft werden.
- `dump.js` im Hintergrund: Solana-Tape gibt es nur bei offener Token-Seite.
- **Dex-Paid-Gate:** erledigt. Von 300 Pulse-Token hatte genau einer
  `dexscreenerAdPaid: true` — als harte Vorbedingung hätte das 🔥 auf Solana
  komplett stillgelegt. `chain.js` führt dafür die Capability `dexPaidGate`
  (EVM ja, Solana nein); `filter.js:isHot()` und `watcher.mjs:safetyPass()`
  fragen sie ab. **Nur das Gate fällt** — als Punkt in `statBonus` zählt Dex
  Paid weiter, denn dass jemand Geld ausgegeben hat, bleibt ein Signal. Alle
  übrigen Gates gelten unverändert. Eine unbekannte Chain behält das strengere
  EVM-Verhalten.
- **🛡-Chip.** `intel.js` mischt `securityFor()` unter die geparsten
  Panel-Werte (Panel gewinnt, die API füllt nur Lücken) und baut die Checkliste
  chain-abhängig:

  | Check | Robinhood | Solana |
  | --- | --- | --- |
  | Renounced | zählt | entfällt (dort immer „—") |
  | Dex Paid | zählt | nur als Treffer, nie als Fehlschlag |
  | Tax | aus dem Panel | aus `buy/sellFeePercentage` |
  | Mint revoked | — | zählt (`isMintable`) |
  | Freeze revoked | — | zählt (`isFreezable`) |

  Der Nenner **steigt** auf Solana dadurch (8 → 10 im Testfixture): es fallen
  zwei Checks weg, aber Tax und die beiden Authorities kommen dazu. Ohne
  Security-Block bleiben Mint/Freeze `null` — „noch niemand hat berichtet"
  darf nie als „widerrufen" durchgehen.

- `api/2/token/details` bleibt ungetappt — die Socials kommen bereits aus dem
  Pulse-Payload.

- **Bonding-Curve-Pool.** Der Pool ist kein Holder: auf einer frischen
  pump.fun-Kurve steht er auf Rang 1 mit der unverkauften Supply — live
  gemessen 100 % vor dem ersten Kauf, 85 % kurz danach. `holders.js` filtert
  ihn jetzt aus `analyze()` **und** `trackFlow()`. Erkennung primär über das
  API-Label `labels: ["liquidityPool"]` (die API markiert die Zeile selbst),
  Adressvergleich gegen `poolFor()` nur als Rückfall. Bleibt danach kein
  Holder übrig, meldet das Readout gar nichts — ehrlicher als „1 Holder mit
  100 %".

---

## 7. Kalibrierung

Die 🔥-Gates in `constants.js` sind aus der Robinhood-Population abgeleitet
(PONS/Index/wire gegen RYFT). Die Solana-Population ist eine andere: nahezu
jede Karte trägt `Pump.fun` oder `Meteora DBC` (beide stehen in `memeBadges`),
und `Dex Paid` ist auf frischen pump.fun-Token praktisch immer `Unpaid` —
`isHot()` verlangt `stats.paid` als harte Vorbedingung und kann auf Solana
daher faktisch nie auslösen.
