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

## Revision (2026-07-24): Bring-your-own-Key, kein Proxy

Der ursprüngliche Plan sah einen VPS-Proxy vor, weil ein **geteilter**
Entwickler-Key aus jeder entpackten Extension abgreifbar wäre. Die gewählte
Architektur ist stattdessen **BYO-Key**: jeder User wählt seinen Anbieter und
trägt seinen **eigenen** Key ein. Der liegt dann in dessen eigenem
`chrome.storage.local` — dasselbe Modell wie das bestehende `tgToken`, das
schon so gehandhabt wird (Storage → nur in `background.js` benutzt → nie im
Content-Script). Damit entfällt der VPS komplett: kein Server, kein systemd,
kein Shared Secret. Phase 4/5 unten sind entsprechend neu gefasst.

## Phase 4 — Provider-Layer + Background-Handler (clientseitig)

Der Key darf nie ins MAIN world: sonst läse basedbot.app ihn selbst aus. Also
läuft der Call über `background.js` (wie Telegram), der Snapshot fließt
Content → Background, der Key bleibt im Background.

**Zwei Request-Formen decken „fast alle bekannten KI" ab:**

- **OpenAI-kompatibel** (`POST {baseUrl}/chat/completions`, `Authorization:
  Bearer`): OpenAI, GLM (Zhipu, `open.bigmodel.cn/api/paas/v4`), Kimi/Moonshot
  (`api.moonshot.cn/v1`), DeepSeek, OpenRouter, lokale Modelle — **und Google
  Gemini** über dessen OpenAI-Endpoint (`…/v1beta/openai`). Eine Form, viele
  Anbieter.
- **Anthropic nativ** (`POST {baseUrl}/v1/messages`, `x-api-key`,
  `anthropic-version`): Claude.

**`src/provider.js` (pur, testbar):** die gesamte Anbieter-Logik ohne DOM,
`chrome.*` oder `fetch`, damit sie unter `node:test` läuft.

```js
BBD.provider = {
  PRESETS,                                   // Anbieter → { adapter, baseUrl, defaultModel }
  buildRequest({ adapter, baseUrl, model, apiKey, system, user }),  // → { url, headers, body }
  parseResponse({ adapter, status, json }),  // → { text } | { error }
  extractVerdict(text)                        // → Verdict | null (defensiv, ersetzt Schema)
};
```

`extractVerdict` ist der Ersatz für Anthropics Structured Outputs: nicht jeder
Anbieter garantiert JSON. Also erstes balanciertes `{…}` aus der Antwort
ziehen (auch aus ```json-Fences), parsen, gegen die Verdict-Form validieren,
bei Unbrauchbarem `null`. `response_format: {type:'json_object'}` wird auf der
OpenAI-Seite mitgeschickt, wo unterstützt, aber der Parser verlässt sich nicht
darauf.

**`background.js`:** dünner Handler `bbd-advisor-verdict` — liest Key aus
Storage, ruft via `provider.buildRequest`/`parseResponse` den Endpoint, gibt
das Verdict zurück. Key wird nie geloggt, nie an den Absender-Tab
weitergereicht (nur das Verdict).

**`manifest.json`:** `optional_host_permissions` statt fester Hosts (der User
kann jede Base-URL eintragen); die konkrete Origin wird beim Speichern der
Einstellungen per `chrome.permissions.request` angefragt. Der Background-Fetch
mit Host-Permission umgeht CORS — noch ein Grund, warum der Call dort und nicht
im Content-Script sitzt.

**Kosten** laufen jetzt auf dem **eigenen Konto des Users** — kein geteiltes
Budget. Der clientseitige Dedup-Cache (Phase 5) bleibt trotzdem: er spart dem
User Tokens, nicht uns.

**Verdict-Form** (anbieterunabhängig, per `extractVerdict` validiert):

```json
{
  "risk":       "low | medium | high | critical",
  "headline":   "ein Satz",
  "supports":   ["..."],
  "against":    ["..."],
  "watchFor":   ["..."],
  "confidence": "low | medium | high"
}
```

**`against` ist Pflicht, kein optionales Feld** — das Modell muss zu jeder
Einschätzung Gegenargumente liefern. Das ist die wirksamste Bremse gegen
Ausgaben, die sicherer klingen als die Datenlage hergibt. **Bewusst kein
`action: buy/sell`** (Begründung unter „Grenzen"). `extractVerdict` verwirft
eine Antwort, der `against` oder `risk` fehlt.

**Prompt statt Sampling-Parameter:** `temperature`/`top_p` werden nicht gesetzt
(manche Anbieter lehnen sie ab, andere deuten sie anders) — Steuerung läuft
über den System-Prompt (`RUBRIC`). `max_tokens` bewusst niedrig (~1200): die
Ausgabe ist ein kurzes Verdict, kein Aufsatz.

**Kosten** trägt der User auf seinem eigenen Konto und hängen vom gewählten
Modell ab — die Extension zeigt keine Preise an, sondern hält den Call
on-demand (Button/Event, nie pro Tick) und dedupt über den Cache in Phase 5.

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
`advisorEnabled` (default `false` — Opt-in, kostenpflichtig auf dem eigenen
Konto), `advisorProvider` (Preset-Auswahl), `advisorBaseUrl`, `advisorModel`,
`advisorApiKey`, `advisorOnDump`, `advisorOnBanner`. Der Key wird — wie
`tgToken` — nur aus dem Background gelesen, nie im Content-Script.

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
| 4 | Provider-Layer + Background (BYO-Key) | — | 3 |
| 5 | `advisor.js` + UI | das eigentliche Feature | 4 |
| 6 | Kalibrierung | belegt, ob Phase 5 etwas taugt | 5 + Zeit |

Phase 1 und 2 lohnen sich unabhängig davon, ob Phase 4–6 je gebaut werden.
Deshalb stehen sie vorn.
