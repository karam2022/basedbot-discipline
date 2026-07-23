# KI-Advisor — Plan

Ziel: aus den Daten, die die Extension ohnehin schon abgreift, eine
KI-gestützte Einschätzung bauen — Risiko, Momentum, Kontext — und sie dort
anzeigen, wo der Nutzer ohnehin hinschaut. **Kein Auto-Trading**, keine
Order-Ausführung: die Extension fasst an, was sie sieht, und sagt es. Die
Entscheidung bleibt beim Nutzer (siehe README, "It never touches the buy or
sell button").

---

## 0. Datenlage (verifiziert am 2026-07-23, live auf basedbot.app)

| Quelle | Was | Status |
| --- | --- | --- |
| `/api/tokens/metrics/batch` | top10, dev, snipers, bundlers, insiders, holders, dexPaid | ✅ getappt (`interceptor.js`) |
| `/api/tokens` | liquidity_usd, market_cap_usd | ✅ getappt |
| `/api/audit/batch` | Contract-/Hook-Safety, NDJSON | ✅ getappt |
| `/api/v1/balances` | Positionen + unrealized PnL | ✅ getappt |
| `/api/prices` | ETH/SOL-Kurse | ✅ getappt |
| `/api/token/{addr}/trades?chain&pool` | **volle Tape**, 100 Trades/Seite, `hasMore` | ⚠️ nur in `dump.js` gepollt, nicht getappt |
| `/api/token/{addr}/holders?chain` | Holder-Verteilung | ❌ ungenutzt |
| `wss://basedbot-api.mobula.io` | **Live-Preis-Push** (Solana: `…-swap-enriched-stream-sol…`) | ❌ komplett unbeobachtet |
| `api.basedbot.app/api/v1/monitor/{addr}` | Live-Stats, sekündlich gepollt | ❌ **401 bei direktem fetch** — nur tappbar |

Zwei Befunde, die den Plan bestimmen:

1. **`interceptor.js` patcht nur `window.fetch`.** Der Chart wird von der
   TradingView `charting_library` gerendert und aus einem WebSocket gefüttert.
   Der komplette Live-Preisstrom läuft an unserem Tap vorbei. Gemessen: der
   REST-Tape bewegte sich in 8 s nicht, während der Seitentitel live von
   $12,72M auf $13,39M lief.
2. **Tappen schlägt Nachfragen.** `/api/v1/monitor` gibt bei nacktem `fetch`
   401 zurück — das SPA setzt einen Auth-Header, den wir nicht haben. Über den
   MAIN-World-Tap bekommen wir die Antwort trotzdem. Das gilt für den
   WebSocket erst recht.

Der Chart selbst braucht **kein** Vision-Modell. Alles, was er anzeigt, liegt
als Zahl vor.

---

## 1. Architektur

```
src/interceptor.js   + WebSocket-Tap (MAIN world)          ← Phase 1
src/feed.js          + takeTrades / takeHolders / takeTick ← Phase 1
src/candles.js       OHLCV + Flow-Features aus der Tape    ← Phase 2  (pure)
src/features.js      Snapshot: intel+audit+creator+tape    ← Phase 3  (pure)
vps-watcher/advisor.mjs   LLM-Proxy, Key serverseitig      ← Phase 4
src/advisor.js       Verdict anfordern + cachen            ← Phase 5
src/banner.js        Verdict rendern                       ← Phase 5
popup.js / constants.js   Settings                         ← Phase 5
```

Zwei Schichten, strikt getrennt:

- **Deterministisch (Code).** Schwellwerte, Scores, Hide-Regeln — das läuft
  schon in `score.js`/`intel.js`/`filter.js`, ist kostenlos, sofort und
  reproduzierbar. Wird **nicht** an ein Modell delegiert.
- **Synthese (LLM).** Genau die Fälle, in denen die Regeln sich widersprechen:
  Contract sauber, aber Dev hat drei Rugs; Holder-Struktur gut, aber 40 Trades
  von 6 Wallets. Das Modell bekommt einen fertigen Zahlen-Snapshot und
  formuliert Risiko + Gegenargumente.

---

## Phase 1 — WebSocket-Tap (Voraussetzung für alles)

**`src/interceptor.js`:** zweiter Patch neben dem fetch-Patch, gleiche
`postMessage`-Bridge, gleicher Buffer.

```js
const origWS = window.WebSocket;
window.WebSocket = function (url, protocols) {
  const sock = protocols === undefined ? new origWS(url) : new origWS(url, protocols);
  if (WS_WATCHED.test(String(url))) {
    sock.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') post('tick', ev.data);
    });
  }
  return sock;
};
window.WebSocket.prototype = origWS.prototype;
Object.assign(window.WebSocket, origWS);
```

Fallstricke, die im Test abgedeckt gehören:

- Der Patch muss **vor** dem ersten Socket der App stehen — `run_at:
  document_start` haben wir schon, das passt.
- Sockets, die vor dem Patch entstehen, sind nicht mehr erreichbar. Bei einem
  Extension-Reload auf einer offenen Seite fehlen also Ticks bis zum nächsten
  Reload. Das ist akzeptabel; wichtig ist, dass der Preis dann sauber auf die
  bestehende DOM-/Balance-Quelle zurückfällt statt einzufrieren.
- Payload ist untrusted input — Validierung in `feed.js`, wie bei allen anderen
  Kinds auch (`pct`/`count`/`usd`/`isAddr`).
- `WS_WATCHED` muss beide Hosts matchen: `basedbot-api.mobula.io` und
  `basedbot-swap-enriched-stream-*.mobula.io`.

**`src/feed.js`:** neue Map `ticks` (addr → `{ priceUsd, mcap, ts }`) mit
kurzem TTL (~15 s). Wo `pnl.js` und `banner.js` heute DOM-Preise parsen, wird
der Tick zur bevorzugten Quelle — mit derselben Frische-Logik, die
`STATS_TTL_MS` schon vorgibt: stale verliert gegen einen frischen DOM-Parse.

**Nutzen ohne jede KI:** echter Live-Preis für Take-Profit, Stop-Loss und
Peak-Giveback statt Layout-abhängigem `innerText`.

Tests: `test/interceptor.test.js` (Patch-Verhalten, Buffer-Replay),
Erweiterung von `test/feed.test.js` (Tick-Validierung, TTL, Fallback).

---

## Phase 2 — `src/candles.js` (pure, testbar, KI-unabhängig)

Kerzen und Flow-Features aus der Trades-Tape. Kein DOM, kein `chrome.*` —
dieselbe Bauart wie `detect()` in `dump.js:21`, damit es unter `node:test`
läuft.

```js
BBD.candles = {
  build(trades, { bucketMs, now }),   // → [{ t, o, h, l, c, v, buys, sells }]
  flow(trades, { windowMs, now }),    // → Flow-Kennzahlen
};
```

`flow()` liefert die Zahlen, die ein Chart-Bild nur andeutet:

| Feature | Warum |
| --- | --- |
| `buyRatio` | Volumen-Buy/Sell im Fenster — Druckrichtung |
| `uniqueBuyers` / `uniqueSellers` | 200 Trades von 8 Wallets ≠ echte Nachfrage |
| `top3TraderShare` | Ein Wallet macht 60 % des Volumens = Wash-Verdacht |
| `proTraderNet` | `is_pro_trader` ist **pro Trade** markiert — Smart-Money-Flow ohne eigene Wallet-Klassifizierung |
| `sniperNet` | dito für `is_sniper` |
| `devSold` | Creator-Adresse aus `feed.creator` gegen `trader_full` |
| `volumeTrend` | Volumen letzte 5 min vs. 5 min davor |
| `priceChangePct` | über 1/5/15 min aus den Kerzen |

Timestamps sind `"YYYY-MM-DD HH:MM:SS"` in UTC — der Parser aus `dump.js:15`
wird geteilt, nicht dupliziert.

Historie: `hasMore: true` heißt, ältere Seiten sind nachladbar. Für den ersten
Wurf reicht die aktuelle Seite (~11 min Tape beim getesteten Token); Paging
kommt erst, wenn längere Fenster gebraucht werden.

Tests: `test/candles.test.js` mit einer eingefrorenen echten Tape-Antwort als
Fixture.

---

## Phase 3 — `src/features.js` (pure)

Baut den Snapshot, der an das Modell geht. Kompaktes, flaches JSON — je
kleiner, desto billiger und desto weniger Halluzinationsfläche.

```json
{
  "symbol": "AI", "chain": "robinhood", "ageHours": 216,
  "market":  { "mcapUsd": 12740000, "liqUsd": 543100, "volume24hUsd": 10560000 },
  "safety":  { "top10": 19, "dev": 0, "snipers": 0, "insiders": 9, "bundlers": 0,
               "holders": 5010, "proTraders": 61, "dexPaid": true,
               "lpBurned": 100, "renounced": true, "taxBuy": 0, "taxSell": 2 },
  "audit":   { "danger": false, "critical": false, "reasons": [] },
  "creator": { "priorTokens": 3, "priorRugs": 1, "medianPeakMcap": 80000 },
  "flow":    { "windowMin": 15, "buyRatio": 0.63, "uniqueBuyers": 41,
               "uniqueSellers": 28, "top3TraderShare": 0.22,
               "proTraderNetUsd": 4100, "sniperNetUsd": -900,
               "devSold": false, "volumeTrend": 1.4 },
  "price":   { "changePct1m": 0.5, "changePct5m": 2.1, "changePct15m": -1.3 },
  "position": { "held": true, "pnlPct": 34, "peakPct": 51 },
  "rules":   { "score": 6, "hot": false, "gem": true, "hideReasons": [] }
}
```

`rules` wird bewusst mitgeschickt: das Modell soll das Urteil der
deterministischen Schicht **kennen** und dazu Stellung nehmen, nicht daneben
raten.

---

## Phase 4 — Proxy in `vps-watcher/`

Der API-Key darf **nicht** in die Extension. Jede installierte Extension ist
entpackt lesbar; ein eingebetteter Key ist binnen Tagen abgegriffen und wird
auf fremde Rechnung verbraten. `vps-watcher/` läuft bereits als
systemd-Service (`basedbot-watcher.service`) und ist der natürliche Ort.

**`vps-watcher/advisor.mjs`** — kleiner HTTP-Endpoint neben dem Watcher-Loop:

```js
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic(); // liest ANTHROPIC_API_KEY aus der Umgebung
```

Request an das Modell:

```js
const verdict = await client.messages.create({
  model: 'claude-opus-4-8',
  max_tokens: 1200,
  system: [{ type: 'text', text: RUBRIC }],
  output_config: {
    effort: 'low',
    format: { type: 'json_schema', schema: VERDICT_SCHEMA },
  },
  messages: [{ role: 'user', content: JSON.stringify(snapshot) }],
});
```

Begründung der Parameter:

- **`claude-opus-4-8`** — 1M Kontext, $5/$25 pro MTok.
- **`output_config.format`** mit JSON-Schema statt Freitext-Parsing. Garantiert
  parsebare Ausgabe; kein Regex auf Modellprosa. (Assistant-Prefill ist auf
  Opus 4.8 nicht mehr erlaubt und würde 400 werfen — Structured Outputs sind
  ohnehin der richtige Ersatz.)
- **`effort: 'low'`** für den Live-Pfad: kurze, schnelle Verdicts. Der
  Journal-Rückblick (unten) läuft dagegen mit `thinking: { type: 'adaptive' }`
  und `effort: 'high'` — dort ist Latenz egal und Tiefe erwünscht.
- **Kein `temperature`/`top_p`.** Sampling-Parameter werden auf Opus 4.8 mit
  400 abgelehnt; Steuerung läuft über den Prompt.
- `max_tokens: 1200` ist bewusst niedrig — die Ausgabe ist ein kurzes
  strukturiertes Verdict, kein Aufsatz.

`VERDICT_SCHEMA` (Kern):

```json
{
  "type": "object",
  "properties": {
    "risk":      { "type": "string", "enum": ["low", "medium", "high", "critical"] },
    "headline":  { "type": "string" },
    "supports":  { "type": "array", "items": { "type": "string" } },
    "against":   { "type": "array", "items": { "type": "string" } },
    "watchFor":  { "type": "array", "items": { "type": "string" } },
    "confidence":{ "type": "string", "enum": ["low", "medium", "high"] }
  },
  "required": ["risk", "headline", "supports", "against", "watchFor", "confidence"],
  "additionalProperties": false
}
```

**Bewusst nicht im Schema: ein `action`-Feld mit `buy`/`sell`.** Begründung
unten unter "Grenzen".

`against` ist Pflichtfeld, nicht optional — das Modell muss zu jeder
Einschätzung Gegenargumente liefern. Das ist die wirksamste Bremse gegen
Ausgaben, die sicherer klingen als die Datenlage hergibt.

Weitere Proxy-Aufgaben:

- Shared secret zwischen Extension und Proxy (`config.json`), damit der
  Endpoint nicht offen im Netz steht.
- Rate-Limit pro Token-Adresse (z. B. max. 1 Verdict/2 min) und globales
  Tageslimit — schützt gegen versehentliche Kostenexplosion durch eine
  Endlosschleife im Content-Script.
- Verdict-Cache serverseitig, gekeyed auf `(addr, gerundeter Feature-Hash)`.

**`host_permissions`** in `manifest.json` muss um den Proxy-Host erweitert
werden.

### Kosten

Snapshot ~1.500 Input-Tokens, Verdict ~400 Output-Tokens:

```
1.500 × $5/1M  = $0,0075
  400 × $25/1M = $0,0100
                 ─────────
                 ≈ $0,018 pro Analyse  (~1,8 Cent)
```

100 Analysen/Tag ≈ $1,80/Tag. Deshalb **on-demand**, nicht pro Feed-Tick — bei
70 Tokens pro Pulse-Refresh wären das $1,26 pro Reload.

Zum Prompt-Caching: der Break-even liegt bei zwei Requests, aber das
Minimum für einen cachebaren Prefix ist auf Opus 4.8 **4096 Tokens**. Kürzere
System-Prompts cachen still nicht — kein Fehler, nur `cache_creation_input_tokens: 0`.
Erst prüfen, ob `RUBRIC` diese Größe überhaupt erreicht, bevor
`cache_control` gesetzt wird.

---

## Phase 5 — `src/advisor.js` + UI

Trigger — **niemals** pro Tick:

1. **Button** am 🛡-Chip auf der Token-Seite ("KI-Check"). Der Hauptpfad.
2. **Automatisch bei bestehenden Events**, sofern in den Settings aktiviert:
   wenn ein Dump-Alert feuert oder das Take-Profit-Banner erscheint. Das sind
   genau die Momente, in denen eine zweite Meinung zählt.

Dedup: Verdict pro `(addr, Feature-Bucket)` in `chrome.storage.local` mit TTL,
analog `BBD.KEYS.*`. Gleicher Token + unwesentlich veränderte Zahlen = kein
neuer Call.

Rendering in `banner.js`: `risk` als farbiger Chip, `headline` als eine Zeile,
`supports`/`against` aufklappbar. `against` wird **immer** mit angezeigt, nie
hinter einem Klick versteckt.

Settings in `constants.js`/`popup.js`, im bestehenden schemagetriebenen Stil:
`advisorEnabled` (default `false` — Opt-in, weil kostenpflichtig),
`advisorUrl`, `advisorSecret`, `advisorOnDump`, `advisorOnBanner`.

---

## Phase 6 — Kalibrierung über das Journal

Der Teil, der den Advisor von "klingt klug" zu "ist nachweislich nützlich"
bringt.

`journal.js` protokolliert bereits Entry-Snapshot, Peak und Exit. Wenn jedes
Verdict mit protokolliert wird, lässt sich rückwirkend auswerten:

- Wie oft lag `risk: "critical"` vor einem tatsächlichen Rug?
- Wie oft lag `risk: "low"` vor einem Totalverlust?
- Sagt `confidence` überhaupt etwas über die Trefferquote aus?

Zusätzlich ein zweiter, langsamer Pfad: **Journal-Rückblick.** Über die letzten
N geschlossenen Trades mit `thinking: { type: 'adaptive' }` und `effort: 'high'`
— "welche Muster verlieren bei dir Geld". Hier ist Latenz egal, Sprache genau
die richtige Ausgabeform, und die Daten sind echt statt spekulativ. Das ist
vermutlich der ehrlichste Nutzen von KI in diesem Projekt.

---

## Grenzen — ehrlich

1. **Kein Vorhersage-Edge auf Preise.** Das Modell liest das Feature-JSON und
   formuliert es aus. Es sieht keine Zukunft. Es wird trotzdem sehr überzeugend
   klingen, und genau das ist das Risiko: die Ausgabe wirkt sicherer, als die
   Datenlage rechtfertigt. Deshalb Pflichtfeld `against`, deshalb `confidence`,
   deshalb kein `action: "buy"`.
2. **Kein Timing.** Ein LLM-Call braucht 1–3 s. Bei einem Launch sind das
   mehrere Kerzen. "Kauf jetzt" ist strukturell nicht lieferbar — der Advisor
   ist ein Risiko-Filter, kein Entry-Signal.
3. **Rechenaufgaben gehören in den Code.** `top10 < 30` ist Arithmetik.
   Modelle rechnen langsamer und gelegentlich falsch. Alles Deterministische
   bleibt in `score.js`/`candles.js`.
4. **Kein Auto-Trading.** Bleibt so. Die Prämisse des Projekts ist Disziplin —
   dass *du* entscheidest.

---

## Reihenfolge

| # | Phase | Nutzen für sich allein | Abhängig von |
| --- | --- | --- | --- |
| 1 | WebSocket-Tap | echter Live-Preis für TP/SL/Peak | — |
| 2 | `candles.js` | Buy-Ratio & Unique-Buyer sind eigenständige Signale | 1 |
| 3 | `features.js` | — | 1, 2 |
| 4 | Proxy | — | 3 |
| 5 | `advisor.js` + UI | das eigentliche Feature | 4 |
| 6 | Kalibrierung | belegt, ob Phase 5 etwas taugt | 5 + Zeit |

Phase 1 und 2 lohnen sich unabhängig davon, ob Phase 4–6 je gebaut werden.
Deshalb stehen sie vorn.
