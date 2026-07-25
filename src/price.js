// Token-page live price: poll the confirmed trade tape because the real swap
// socket is binary and lives inside a Web Worker the extension cannot reach.
'use strict';

BBD.price = (() => {
  const TAPE_LIMIT = 500; // the endpoint's cap; larger values return 500 anyway
  const launchTried = new Set(); // addr -> attempted this session, success or not

  // sort=asc returns the token's earliest trades. Only lowercase works — ASC
  // and friends fall through to desc, which would silently cache the newest
  // page as if it were the launch.
  const fetchLaunch = async (addr, baseParams) => {
    try {
      const key = addr.startsWith('0x') ? addr.toLowerCase() : addr;
      if (launchTried.has(key) || BBD.feed.hasLaunch(addr)) return;
      launchTried.add(key);
      const params = new URLSearchParams(baseParams);
      params.set('sort', 'asc');
      params.set('limit', String(TAPE_LIMIT));
      const res = await fetch(`/api/token/${addr}/trades?${params}`, {
        credentials: 'same-origin'
      });
      if (!res.ok) return;
      const json = await res.json();
      BBD.feed.noteLaunch(addr, (json && json.data) || []);
    } catch (err) {
      // One missing launch page costs a signal, never the price poll.
    }
  };

  const HOLDERS_TTL_MS = 45 * 1000; // holder PnL drifts; refresh, don't spam
  const holdersInFlight = new Set();

  // The holder list is a separate endpoint from the tape, keyed by chain only.
  // It is refreshed on its own slow cadence rather than every 2.5s poll, and an
  // in-flight guard stops the fast poll from firing overlapping refetches.
  const fetchHolders = async (addr, chain) => {
    const key = addr.startsWith('0x') ? addr.toLowerCase() : addr;
    try {
      if (holdersInFlight.has(key) || BBD.feed.holdersAgeMs(addr) < HOLDERS_TTL_MS) return;
      holdersInFlight.add(key);
      const params = new URLSearchParams();
      if (chain) params.set('chain', chain);
      const res = await fetch(`/api/token/${addr}/holders?${params}`, {
        credentials: 'same-origin'
      });
      if (!res.ok) return;
      const json = await res.json();
      BBD.feed.noteHolders(addr, (json && json.data) || []);
    } catch (err) {
      // Holder enrichment is optional; its failure never touches the price poll.
    } finally {
      holdersInFlight.delete(key);
    }
  };

  const hide = () => {
    const el = document.getElementById('bbd-price');
    if (el) el.style.display = 'none';
  };

  // The scalp panel grows and shrinks with how much it has to say, so a fixed
  // offset for the pill above it eventually collides — which is exactly what a
  // full readout did. Sit the pill on the panel's real height instead, falling
  // back to the panel's own anchor when it is hidden.
  const SCALP_ANCHOR = 104;
  const GAP = 8;
  const positionPrice = () => {
    try {
      const el = document.getElementById('bbd-price');
      if (!el || el.style.display === 'none') return;
      const scalp = document.getElementById('bbd-scalp');
      let bottom = SCALP_ANCHOR;
      if (scalp && scalp.style.display !== 'none' && scalp.offsetHeight > 0) {
        const anchor = parseInt(getComputedStyle(scalp).bottom, 10);
        bottom = (Number.isFinite(anchor) ? anchor : SCALP_ANCHOR) +
          scalp.offsetHeight + GAP;
      }
      el.style.bottom = `${bottom}px`;
    } catch (err) {
      // Layout math must never break the poll; the CSS fallback still applies.
    }
  };

  const trimDecimalZeros = (value) =>
    value.includes('.') ? value.replace(/\.?0+$/, '') : value;

  // toPrecision handles significant figures well but switches tiny values to
  // exponential notation; expand that notation so prices stay human-readable.
  const plainSignificant = (value, significantFigures) => {
    const precise = value.toPrecision(significantFigures);
    if (!/[eE]/.test(precise)) return trimDecimalZeros(precise);

    const [coefficient, exponentText] = precise.toLowerCase().split('e');
    const exponent = Number(exponentText);
    const digits = coefficient.replace('.', '');
    const decimalAt = exponent + 1;
    let plain;
    if (decimalAt <= 0) {
      plain = `0.${'0'.repeat(-decimalAt)}${digits}`;
    } else if (decimalAt >= digits.length) {
      plain = `${digits}${'0'.repeat(decimalAt - digits.length)}`;
    } else {
      plain = `${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
    }
    return trimDecimalZeros(plain);
  };

  const formatPrice = (priceUsd) => {
    let price;
    try {
      price = Number(priceUsd);
    } catch (err) {
      return '';
    }
    if (!Number.isFinite(price) || price <= 0) return '';

    // Three significant figures keep suffixed values as short as the badge's
    // compact contract ($1.23K); unsuffixed prices retain four.
    const suffix = price >= 1e6 ? 'M' : price >= 1e3 ? 'K' : '';
    const scale = suffix === 'M' ? 1e6 : suffix === 'K' ? 1e3 : 1;
    const figures = suffix ? 3 : 4;
    return `$${plainSignificant(price / scale, figures)}${suffix}`;
  };

  const changeNode = (label, value) => {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(document.createTextNode(`${label} `));
    const number = document.createElement('span');
    number.className = value >= 0 ? 'bbd-price-up' : 'bbd-price-down';
    number.textContent = `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
    fragment.appendChild(number);
    return fragment;
  };

  const render = (priceUsd, changes) => {
    const text = formatPrice(priceUsd);
    if (!text) {
      hide();
      return;
    }

    let el = document.getElementById('bbd-price');
    if (!el || !el.isConnected) {
      el = document.createElement('div');
      el.id = 'bbd-price';
      document.body.appendChild(el);
    }

    const value = document.createElement('span');
    value.className = 'bbd-price-value';
    value.textContent = text;

    const line = document.createElement('span');
    line.className = 'bbd-price-change';
    const legs = [
      ['1m', changes && changes.changePct1m],
      ['5m', changes && changes.changePct5m]
    ].filter(([, change]) => Number.isFinite(change));
    legs.forEach(([label, change], index) => {
      if (index) line.appendChild(document.createTextNode(' · '));
      line.appendChild(changeNode(label, change));
    });

    el.replaceChildren(value);
    if (legs.length) el.appendChild(line);
    el.style.display = 'block';
  };

  const tick = async () => {
    try {
      if (!BBD.alive()) return;
      const path = location.pathname;
      const addr = BBD.tokenAddrFromHref(path);
      if (!path.includes('/token/') || !addr) {
        hide();
        if (BBD.scalp) BBD.scalp.hide();
        return;
      }

      const settings = await BBD.store.settings();
      if (!BBD.alive()) return;
      if (!settings.priceTickerEnabled && !settings.scalpReadoutEnabled) {
        hide();
        if (BBD.scalp) BBD.scalp.hide();
        return;
      }

      const pool = BBD.feed.poolFor(addr);
      // The page's own load request supplies this routing fact shortly after
      // navigation; keep the last good price visible while waiting for it.
      if (!pool || !pool.pool) {
        if (BBD.scalp) BBD.scalp.hide();
        return;
      }

      const params = new URLSearchParams();
      const route = path.match(/\/token\/([^/]+)\//);
      const chain = pool.chain || (route && route[1]);
      if (chain) params.set('chain', chain);
      params.set('pool', pool.pool);
      // The page asks for 100 rows, which on a busy token is about two minutes.
      // 500 is the server's cap and stretches the same single request to
      // roughly twelve, which is what the wallet readout needs to say anything.
      params.set('limit', String(TAPE_LIMIT));

      // The oldest page never changes, so it is fetched once per token and
      // then served from cache — including across reloads.
      fetchLaunch(addr, params);
      // Holder enrichment only runs when the readout that consumes it is on.
      if (settings.scalpReadoutEnabled && settings.holderReadoutEnabled !== false) {
        fetchHolders(addr, chain);
      }

      let response;
      try {
        response = await fetch(`/api/token/${addr}/trades?${params}`, {
          credentials: 'same-origin'
        });
      } catch (err) {
        return;
      }
      if (!response.ok || location.pathname !== path) return;

      let json;
      try {
        json = await response.json();
      } catch (err) {
        return;
      }
      const trades = (json && json.data) || [];
      BBD.feed.notePrice(addr, trades);
      // Same rows, kept instead of discarded: wallet-level questions need more
      // history than one page carries, and this poll is where it accumulates.
      BBD.feed.noteTrades(addr, trades);

      if (settings.priceTickerEnabled) {
        const current = BBD.feed.tickFor(addr);
        if (current) {
          const now = Date.now();
          const candles = BBD.candles.build(trades, {
            bucketMs: 60 * 1000,
            now
          });
          const changes = BBD.candles.priceChanges(candles, { now });
          render(current.priceUsd, changes);
        }
      } else {
        hide();
      }

      if (settings.scalpReadoutEnabled && BBD.scalp) {
        await BBD.scalp.render(addr, trades, settings);
      } else if (BBD.scalp) {
        BBD.scalp.hide();
      }

      // After the panel has rendered its final height for this tick, lift the
      // price pill clear of it so the two never overlap.
      if (settings.priceTickerEnabled) positionPrice();
    } catch (err) {
      // Storage and extension APIs disappear under post-reload orphans; the
      // next healthy script instance owns the badge and polling lifecycle.
    }
  };

  return { tick, formatPrice };
})();
