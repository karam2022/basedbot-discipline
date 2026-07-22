# basedbot.app — Webseiten-Analyse (für die Extension)

Analysiert am 2026-07-21 mit Chrome DevTools auf `https://basedbot.app/robinhood`
(Discover-Feed der Robinhood-Chain), einer Token-Detail-Seite und `/portfolio`.

## 1. Tech-Stack

- **Next.js mit Turbopack** (Chunks unter `/_next/static/chunks/turbopack-…`), **React** (Fiber-Keys `__reactFiber$…` am DOM), **Tailwind CSS v4** mit Container-Queries (`@min-[768px]:…`-Klassen).
- Tooltips/UI-Primitives im shadcn/Radix-Stil: Chips tragen `data-slot="tooltip-trigger"` und `data-state="closed"` — **das sind die stabilsten Selektor-Hooks auf der ganzen Seite**, alles andere sind generierte Tailwind-Utility-Klassen.
- Theming über CSS-Variablen: `text-[var(--destructive)]` (rot) / `text-[var(--success)]` (grün) auf den Stat-Chips — die Seite färbt Risiko-Werte selbst ein. Diese Farbklasse ist ein zusätzliches Signal, das die Extension mitlesen könnte.
- Rows nutzen `cv-auto-lg` (content-visibility) — Offscreen-Rows werden lazy gerendert. `innerText` erzwingt Layout; bei sehr langen Listen kann das Scannen aller Rows teurer sein als nötig.
- Der Seitentitel enthält den Live-Preis (`"NOELCLAW ↑ $62.7K | BasedBot"`) — billige Preisüberwachung ohne DOM-Scan möglich.

## 2. Discover-Feed (`/robinhood`, analog `/pulse/...`)

Echte `<table>` mit `<thead>`-Headern (nicht div-basiert!):

```
Pair Info | Trend | Market Cap | Liquidity | Volume | Fees | TXNS | Tax | Token Info | Action
```

- 50 Rows (`tbody tr`), 10 Zellen pro Row.
- **Token-Adresse steht im href**: `a[href="/token/robinhood/0x842245…"]` — stabiler Identifier, wie ihn `tokenAddrFromHref` bereits nutzt. Externe Links der Row: Launchpad (`ponsfamily.com/launchpad/0x…`), X, Website.
- **Prozentwerte einer Row in Reihenfolge** (wichtig für `parseCardStats`):
  1. Market-Cap-Änderung (z.B. `-7.74%`) — steht VOR den Stats!
  2. Tax B/S/P (z.B. `0%`, `0.09%`, `1%`)
  3. Die letzten 5: `top10, dev, snipers, bundlers, insiders` ✅
- Die „letzte 5"-Heuristik stimmt aktuell — aber die MC-Änderungsspalte beweist, dass Prozentwerte vor den Stats existieren. Kommt je eine Prozent-Anzeige NACH der Token-Info-Zelle dazu, kippt das Parsing still.

### Token-Info-Zelle (robuster parsebar als gedacht)

Jeder Wert ist ein eigener Chip mit `data-slot="tooltip-trigger"`, in fester Reihenfolge:

| Chip | Wert | Icon (SVG-Pfad-Anfang, eindeutig) | Farbe |
|---|---|---|---|
| Holders | `321` | `M2 22C2 17.58…` (Personen) | neutral |
| Pro Traders | `71` | `M3.0585 12.6006…` | neutral |
| Top10 % | `22%` | `M4.6665 4.0833…` | destructive/success |
| Dev % | `0%` | `M3.50021 8.0911…` | success |
| Snipers % | `5%` | `M6.41647 12.804…` | success |
| Bundlers % | `0%` | `M4 5H20V3H4…` | success |
| Insiders % | `0%` | `M12 2a9 9 0 0 0-9 9…` | success |
| Dex Paid | `Paid`/`Unpaid` | Schild-Icon | — |

**Empfehlung:** Statt „letzte 5 Prozentwerte" die Chips über `[data-slot="tooltip-trigger"]` selektieren und per SVG-Pfad-Fingerprint (erste ~30 Zeichen von `path[d]`) dem Feld zuordnen. Icons ändern sich viel seltener als Spalten-Layout. Das ist der Plausibilitäts-Wächter + robustes Parsing in einem.

## 3. Token-Detail-Seite (`/token/{chain}/{addr}`)

- **„Token Info"-Panel rechts**: Es matchen **3 Elemente** auf den Text „Token Info" — ein Wrapper-`DIV`, der Toggle-`BUTTON` und ein `SPAN` im Button. Genau das in verbesserung.md Punkt 3 beschriebene Doppel-Klick-Problem ist real. **Kein `aria-expanded` vorhanden** — Offen-Erkennung muss weiter über die Sichtbarkeit der Kacheln laufen (z.B. Label „Top 10 H." im DOM). Fix: nur `button`-Element klicken (`el.closest('button')` bzw. nur den ersten Button-Match), nie Span/Div.
- **Kacheln sind gelabelt** (`.rounded-lg.px-2.py-2.text-center`, innen Wert-`div` + Label-`div`):
  `Top 10 H.`, `Dev H.`, `Snipers H.`, `Insiders`, `Bundlers`, `Renounced`, `LP Burned`, `LP Locked`, `Token Burn`.
  → `intel.js` kann Label→Wert-Paare parsen statt Positionen — deutlich robuster.
- Social-Links im Header sind echte `<a href>`: Website, `x.com/…`, `t.me/…`, `github.com/…`, Blockscout-Explorer, Launchpad.
- Untere Tabs: Trades, Positions, Orders, Top Traders, Holders, Dev Tokens, Bubble Map — die Trades-Liste ist eine echte Tabelle mit `<thead>`.

## 4. Portfolio-Seite (`/portfolio`)

- **Keine `<table>`-Elemente** — komplett div-basiert (Stand heute, mit „No open positions"). Kennzahlen als Text: Total Value, Unrealized PnL, Realized PnL, Total PnL, Win Rate. Tabs: Positions, Trades, Closed Positions.
- Konsequenz für `pnl.js` (verbesserung.md Punkt 2): Der `<thead>`-basierte Spaltenindex-Fix funktioniert nur, wenn die Positions-Ansicht mit offenen Positionen tatsächlich als Tabelle rendert — mit offenen Positionen erneut prüfen. Falls div-basiert: PnL besser aus der API ziehen (siehe unten).

## 5. Datenquellen / APIs (die große Entdeckung)

Die SPA holt alle Stats als JSON — genau die Werte, die die Extension mühsam aus `innerText` parst:

### `GET /api/tokens?chain&limit&timeframe&tab&ageFilter` (basedbot.app)
Liefert die Feed-Liste (50 Einträge): `address, name, symbol, decimals, chain, price_usd, liquidity_usd, market_cap_usd, total_supply, pool_address, pool_type, quote_symbol, factory, is_launchpad, …` plus `total, page, hasMore, timeframe, tab`.

### `POST /api/tokens/metrics/batch` ⭐
Pro Adresse **exakt die parseCardStats-Felder**:
```
top10HoldersPct, devHoldingsPct, snipersPct, bundlersPct, insidersPct,
holdersCount, proTradersCount, dexPaid, dexPaidDate, creatorAddress, totalFeesNative
```

### `POST /api/tokens/metadata` + `/api/tokens/metadata/batch` ⭐
Pro Adresse **exakt die intel.js-Felder**:
```
website_url, twitter_url, telegram_url, discord_url, extra_links,
icon_url, name, symbol, total_supply, price_native, pool_type, created_at
```

### Weitere Endpoints
- `POST /api/audit/batch`, `POST api.basedbot.app/api/v1/tax/batch` — Audit/Tax-Daten (Renounced/LP-Status vermutlich hier).
- `GET /api/prices` — wird regelmäßig gepollt (ETH, SOL, BNB, …).
- `api.basedbot.app/api/v1/balances`, `/api/v1/balance/native` — Portfolio/Positionen (authentifiziert) → potenzielle PnL-Quelle statt DOM.
- `api.basedbot.app/api/v2/notifications`, `/api/v1/token-alert`, `/api/v1/tracker/*`, `/api/v1/copytrading/targets`.
- **WebSocket**: `wss://api.basedbot.app/ws/viewers-bulk` (Viewer-Zahlen). Live-Preis-Ticks laufen vermutlich über eine weitere WS-Verbindung, die beim Seiten-Load aufgebaut wird (vor Instrumentierung — bei Bedarf mit einem MAIN-World-Script ab Load prüfen).

**Konsequenz:** Der in verbesserung.md („Die eine große Idee", Option 2) vorgeschlagene fetch-Interceptor im MAIN-World-Content-Script ist machbar und lohnt sich: `fetch` patchen, Responses von `/api/tokens`, `/api/tokens/metrics/batch` und `/api/tokens/metadata*` clonen, per `CustomEvent`/`postMessage` an das ISOLATED-World-Script reichen → Scores aus sauberem JSON statt Positions-Parsing. Adress-Keys matchen direkt auf `tokenAddrFromHref`.

## 6. Priorisierte Empfehlungen für die Extension

1. **Kurzfristig (kleine Fixes):** Chips per `data-slot="tooltip-trigger"` + SVG-Fingerprint parsen statt „letzte 5 %-Werte"; im Intel-Panel Label→Wert-Paare lesen; beim Panel-Toggle nur den `<button>` klicken.
2. **Plausibilitäts-Wächter:** Werte > 100 %, fehlende Chips oder 0 geparste Cards trotz vorhandener Rows → einmalige Warnung im Chip statt stiller Fehlklassifikation.
3. **Mittelfristig (der eigentliche Gewinn):** MAIN-World-fetch-Interceptor für `metrics/batch` + `metadata` — macht `parseCardStats` und das Intel-Panel-Scraping komplett überflüssig und übersteht jedes Redesign.
4. **Portfolio/PnL:** mit offenen Positionen erneut prüfen, ob Tabelle oder Divs; sonst `api/v1/balances` als Quelle evaluieren.
