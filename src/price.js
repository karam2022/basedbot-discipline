// Token-page live price: poll the confirmed trade tape because the real swap
// socket is binary and lives inside a Web Worker the extension cannot reach.
'use strict';

BBD.price = (() => {
  const hide = () => {
    const el = document.getElementById('bbd-price');
    if (el) el.style.display = 'none';
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
    } catch (err) {
      // Storage and extension APIs disappear under post-reload orphans; the
      // next healthy script instance owns the badge and polling lifecycle.
    }
  };

  return { tick, formatPrice };
})();
