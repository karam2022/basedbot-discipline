// Token-page AI risk read: assemble the already-observed signals, pass them
// through the privacy allow-list, and keep model calls strictly event-driven.
'use strict';

BBD.advisor = (() => {
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const CACHE_MAX_ENTRIES = 200;
  const FLOW_WINDOW_MS = 15 * 60 * 1000;
  const CANDLE_BUCKET_MS = 60 * 1000;
  const inFlight = new Map();
  const visibleBannerWins = new Set();

  const record = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

  const finite = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  const read = (source, key) => {
    try {
      return record(source) ? source[key] : undefined;
    } catch (err) {
      return undefined;
    }
  };

  const stateBucket = (value) =>
    value === true ? 1 : value === false ? 0 : null;

  // Five coarse risk signals deliberately ignore tiny tape/panel movement:
  // Top-10 uses 5-point bands, holders use decimal magnitude, and buy ratio
  // uses one decimal. Address is the outer cache key, not part of this string.
  const bucket = (snapshot) => {
    const safety = read(snapshot, 'safety');
    const flow = read(snapshot, 'flow');
    const audit = read(snapshot, 'audit');
    const top10 = finite(read(safety, 'top10'));
    const holders = finite(read(safety, 'holders'));
    const buyRatio = finite(read(flow, 'buyRatio'));
    return JSON.stringify({
      top10Band: top10 === null ? null : Math.floor(top10 / 5) * 5,
      holderMagnitude: holders === null
        ? null : holders === 0 ? '0' : `1e${Math.floor(Math.log10(Math.abs(holders)))}`,
      buyRatio: buyRatio === null ? null : Math.round(buyRatio * 10) / 10,
      devSold: stateBucket(read(flow, 'devSold')),
      auditDanger: stateBucket(read(audit, 'danger'))
    });
  };

  const isFresh = (entry, now) => {
    const at = finite(now);
    const ts = finite(read(entry, 'ts'));
    const age = at === null || ts === null ? null : at - ts;
    return record(entry) &&
      typeof read(entry, 'bucket') === 'string' &&
      record(read(entry, 'verdict')) &&
      age !== null && age >= 0 && age < CACHE_TTL_MS;
  };

  const validAddr = (value) => typeof value === 'string' &&
    /^(0x[a-fA-F0-9]{6,}|[1-9A-HJ-NP-Za-km-z]{20,})$/.test(value);

  const sameAddr = (a, b) => {
    if (!a || !b) return false;
    return a.startsWith('0x') && b.startsWith('0x')
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  };

  const routeInfo = () => {
    if (typeof location === 'undefined') return null;
    const pathname = location.pathname;
    const addr = BBD.tokenAddrFromHref(pathname);
    const match = typeof pathname === 'string'
      ? pathname.match(/\/token\/([^/]+)\//)
      : null;
    return addr && match ? { addr, chain: match[1] } : null;
  };

  const configured = (settings) => record(settings) &&
    ['advisorProvider', 'advisorBaseUrl', 'advisorModel', 'advisorApiKey']
      .every((key) => typeof settings[key] === 'string' && settings[key].trim());

  const positionNearIntel = (el) => {
    const intel = document.getElementById('bbd-intel');
    const rect = intel && intel.getBoundingClientRect();
    const viewportWidth = typeof window.innerWidth === 'number' ? window.innerWidth : 0;
    const viewportHeight = typeof window.innerHeight === 'number' ? window.innerHeight : 0;
    const cardWidth = Math.min(420, Math.max(0, viewportWidth - 32));
    if (rect && rect.width > 0 && viewportWidth - rect.right - 8 >= cardWidth) {
      el.style.left = `${Math.round(rect.right + 8)}px`;
      el.style.bottom = `${Math.max(16, Math.round(viewportHeight - rect.bottom))}px`;
      return;
    }
    el.style.left = '16px';
    el.style.bottom = rect && rect.height > 0
      ? `${Math.max(104, Math.round(viewportHeight - rect.top + 8))}px`
      : '104px';
  };

  const ensureEl = () => {
    let el = document.getElementById('bbd-advisor');
    if (!el || !el.isConnected) {
      el = document.createElement('section');
      el.id = 'bbd-advisor';
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }

    let button = el.querySelector('#bbd-advisor-btn');
    if (!button) {
      button = document.createElement('button');
      button.id = 'bbd-advisor-btn';
      button.type = 'button';
      button.textContent = '🤖 KI-Check';
      button.title = 'AI risk read';
      button.addEventListener('click', () => {
        const route = routeInfo();
        if (route) request(route.addr, { reason: 'button' });
      });
      el.prepend(button);
    }

    let output = el.querySelector('.bbd-advisor-output');
    if (!output) {
      output = document.createElement('div');
      output.className = 'bbd-advisor-output';
      el.appendChild(output);
    }
    return { el, button, output };
  };

  const uiFor = (addr) => {
    const route = routeInfo();
    return route && sameAddr(route.addr, addr) ? ensureEl() : null;
  };

  const showLine = (addr, className, text) => {
    const ui = uiFor(addr);
    if (!ui) return;
    const line = document.createElement('div');
    line.className = className;
    line.textContent = text;
    ui.output.replaceChildren(line);
    ui.button.disabled = className === 'bbd-advisor-pending';
    ui.el.style.display = 'block';
    positionNearIntel(ui.el);
  };

  const showPending = (addr) =>
    showLine(addr, 'bbd-advisor-pending', 'KI risk read in progress…');

  const showConfigureHint = (addr) =>
    showLine(addr, 'bbd-advisor-hint', 'Configure the AI advisor in settings.');

  const showError = (addr, reason) =>
    showLine(addr, 'bbd-advisor-error', reason);

  const appendList = (parent, items) => {
    const list = document.createElement('ul');
    for (const value of Array.isArray(items) ? items : []) {
      if (typeof value !== 'string') continue;
      const item = document.createElement('li');
      item.textContent = value;
      list.appendChild(item);
    }
    parent.appendChild(list);
  };

  const renderVerdict = (addr, verdict) => {
    const ui = uiFor(addr);
    if (!ui || !record(verdict)) return;
    const risk = typeof verdict.risk === 'string' ? verdict.risk : 'unknown';
    const riskClass = risk === 'low' ? 'bbd-good'
      : risk === 'medium' ? 'bbd-warn'
        : 'bbd-bad';

    const card = document.createElement('div');
    card.className = 'bbd-advisor-card';

    // Dismiss clears only the verdict output; the 🤖 button stays so the read
    // can be re-run. tick() never repopulates output, so this isn't undone.
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'bbd-advisor-close';
    close.textContent = '×';
    close.title = 'Dismiss';
    close.addEventListener('click', () => ui.output.replaceChildren());
    card.appendChild(close);

    const meta = document.createElement('div');
    meta.className = 'bbd-advisor-meta';
    const chip = document.createElement('span');
    chip.className = `bbd-advisor-risk ${riskClass}`;
    chip.textContent = `Risk: ${risk}`;
    const confidence = document.createElement('span');
    confidence.className = 'bbd-advisor-confidence';
    confidence.textContent = `Confidence: ${
      typeof verdict.confidence === 'string' ? verdict.confidence : 'unknown'
    }`;
    meta.append(chip, confidence);

    const headline = document.createElement('div');
    headline.className = 'bbd-advisor-headline';
    headline.textContent = typeof verdict.headline === 'string' ? verdict.headline : '';

    const supports = document.createElement('details');
    supports.className = 'bbd-advisor-supports';
    const supportsTitle = document.createElement('summary');
    supportsTitle.textContent = 'Supports';
    supports.appendChild(supportsTitle);
    appendList(supports, verdict.supports);

    // Counterarguments stay outside every details element so the model's
    // uncertainty is visible at the same time as its headline.
    const against = document.createElement('div');
    against.className = 'bbd-advisor-against';
    const againstTitle = document.createElement('div');
    againstTitle.className = 'bbd-advisor-list-title';
    againstTitle.textContent = 'Against';
    against.appendChild(againstTitle);
    appendList(against, verdict.against);

    card.append(meta, headline, supports, against);

    if (Array.isArray(verdict.watchFor) && verdict.watchFor.length) {
      const watch = document.createElement('details');
      watch.className = 'bbd-advisor-watch';
      const watchTitle = document.createElement('summary');
      watchTitle.textContent = 'Watch for';
      watch.appendChild(watchTitle);
      appendList(watch, verdict.watchFor);
      card.appendChild(watch);
    }

    const disclaimer = document.createElement('div');
    disclaimer.className = 'bbd-advisor-disclaimer';
    disclaimer.textContent = 'Risk read only — not financial advice.';
    card.appendChild(disclaimer);

    ui.output.replaceChildren(card);
    ui.button.disabled = false;
    ui.el.style.display = 'block';
    positionNearIntel(ui.el);
  };

  const heldPosition = (addr) => {
    const positions = BBD.feed.heldPositions();
    return Array.isArray(positions)
      ? positions.find((position) => position && sameAddr(position.addr, addr))
      : null;
  };

  const tapeFeatures = async (addr, chain, creatorAddr, pool) => {
    if (!pool || !pool.pool) return {};
    const params = new URLSearchParams();
    const tapeChain = pool.chain || chain;
    if (tapeChain) params.set('chain', tapeChain);
    params.set('pool', pool.pool);

    try {
      const response = await fetch(`/api/token/${addr}/trades?${params}`, {
        credentials: 'same-origin'
      });
      if (!response.ok) return {};
      const json = await response.json();
      const trades = (json && json.data) || [];
      const now = Date.now();
      const flow = BBD.candles.flow(trades, {
        windowMs: FLOW_WINDOW_MS,
        now,
        creatorAddr
      });
      const candles = BBD.candles.build(trades, {
        bucketMs: CANDLE_BUCKET_MS,
        now
      });
      const priceChanges = BBD.candles.priceChanges(candles, { now });
      return { flow, priceChanges };
    } catch (err) {
      return {};
    }
  };

  const assembleSnapshot = async (addr, settings) => {
    const route = routeInfo();
    const position = heldPosition(addr);
    const market = BBD.feed.marketFor(addr);
    const stats = BBD.feed.statsFor(addr);
    const audit = BBD.feed.auditFor(addr);
    const creatorAddr = BBD.feed.creatorFor(addr);
    const pool = BBD.feed.poolFor(addr);
    const chain = route && sameAddr(route.addr, addr)
      ? route.chain
      : (position && position.chain) || (pool && pool.chain);

    const [intelCache, tape] = await Promise.all([
      BBD.store.get(BBD.KEYS.intel, {}),
      tapeFeatures(addr, chain, creatorAddr, pool)
    ]);
    const input = {
      symbol: (market && market.symbol) || (position && position.symbol),
      chain,
      market,
      stats,
      intel: record(intelCache) ? intelCache[addr] : undefined,
      audit,
      creator: creatorAddr ? BBD.creator.reputation(creatorAddr, settings) : undefined,
      flow: tape.flow,
      priceChanges: tape.priceChanges,
      position: position ? {
        held: true,
        pnlPct: position.pct,
        peakPct: position.peakPct
      } : undefined
    };
    const snapshot = BBD.features.build(input);
    // A verdict that contradicts the on-page chips is almost always a gap in
    // the snapshot rather than a bad read, and the two are indistinguishable
    // from the outside. This is the scrubbed allow-list output — exactly the
    // bytes that leave the browser — so logging it discloses nothing further.
    try {
      console.debug('[bbd] advisor snapshot', JSON.stringify(snapshot));
    } catch (err) {
      // Logging must never cost a verdict.
    }
    return snapshot;
  };

  const cachedVerdict = async (addr, featureBucket) => {
    const cache = await BBD.store.get(BBD.KEYS.advisor, {});
    const entry = record(cache) ? cache[addr] : null;
    return entry && entry.bucket === featureBucket && isFresh(entry, Date.now())
      ? entry.verdict
      : null;
  };

  const cacheVerdict = async (addr, featureBucket, verdict) => {
    await BBD.store.mergeEntry(BBD.KEYS.advisor, addr, {
      verdict,
      bucket: featureBucket,
      ts: Date.now()
    });
    await BBD.store.pruneMap(BBD.KEYS.advisor, {
      maxAgeMs: CACHE_TTL_MS,
      maxEntries: CACHE_MAX_ENTRIES
    });
  };

  const runRequest = async (addr, options) => {
    const reason = options && options.reason;
    const automatic = reason === 'dump' || reason === 'banner';
    const settings = options && options.settings
      ? options.settings
      : await BBD.store.settings();
    if (!settings.advisorEnabled || !configured(settings)) {
      if (!automatic) showConfigureHint(addr);
      return null;
    }
    const route = routeInfo();
    if (!route || !sameAddr(route.addr, addr)) return null;

    showPending(addr);
    const snapshot = await assembleSnapshot(addr, settings);
    const featureBucket = bucket(snapshot);
    const cached = await cachedVerdict(addr, featureBucket);
    if (cached) {
      renderVerdict(addr, cached);
      return cached;
    }
    if (!BBD.alive()) return null;

    let result;
    try {
      // This allow-listed object is the entire model boundary: no input,
      // trades, wallet state, or trigger metadata accompanies it.
      result = await chrome.runtime.sendMessage({
        type: 'bbd-advisor-verdict',
        snapshot
      });
    } catch (err) {
      if (BBD.alive()) showError(addr, 'AI advisor request failed.');
      return null;
    }

    if (result && result.ok === true && record(result.verdict)) {
      renderVerdict(addr, result.verdict);
      await cacheVerdict(addr, featureBucket, result.verdict);
      // Log a fresh verdict against the open trade so Phase 6b can score the
      // model against the exit. Held tokens only — a token you don't hold has
      // no trade cycle to correlate with. Cache hits skip this (they returned
      // above), so a re-read doesn't double-log the same call.
      const position = heldPosition(addr);
      if (position && position.positionKey && BBD.journal && BBD.journal.noteAdvisor) {
        try {
          await BBD.journal.noteAdvisor(position.positionKey, result.verdict);
        } catch (err) {
          // Calibration logging is best-effort; never break the risk read.
        }
      }
      return result.verdict;
    }
    if (result && result.ok === false && typeof result.reason === 'string') {
      showError(addr, result.reason);
    } else {
      showError(addr, 'AI advisor request failed.');
    }
    return null;
  };

  const request = (addr, options = {}) => {
    if (!validAddr(addr) || !BBD.alive()) return Promise.resolve(null);
    const route = routeInfo();
    if (!route || !sameAddr(route.addr, addr)) {
      if (!route) {
        const existing = document.getElementById('bbd-advisor');
        if (existing) existing.style.display = 'none';
      }
      return Promise.resolve(null);
    }
    const current = inFlight.get(addr);
    if (current) {
      if (options.reason === 'button') showPending(addr);
      return current;
    }
    const task = Promise.resolve()
      .then(() => runRequest(addr, options))
      .catch(() => {
        if (BBD.alive() && options.reason === 'button') {
          showError(addr, 'AI advisor request failed.');
        }
        return null;
      });
    inFlight.set(addr, task);
    task.then(() => inFlight.delete(addr), () => inFlight.delete(addr));
    return task;
  };

  const onDump = async (addr) => {
    try {
      const route = routeInfo();
      if (!route || !sameAddr(route.addr, addr)) return;
      const settings = await BBD.store.settings();
      if (!settings.advisorOnDump || !settings.advisorEnabled || !configured(settings)) return;
      await request(addr, { reason: 'dump', settings });
    } catch (err) {
      // Automatic paths are optional and must never disturb the alert itself.
    }
  };

  const bannerWinAddrs = () => {
    const banner = document.getElementById('bbd-banner');
    if (!banner || banner.style.display === 'none') return [];
    const rows = banner.querySelectorAll(
      '.bbd-banner-row:not(.bbd-banner-row-loss):not(.bbd-banner-row-giveback)'
    );
    const addrs = [];
    for (const row of rows) {
      const link = row.querySelector('a.bbd-banner-msg[href*="/token/"]');
      const addr = link && BBD.tokenAddrFromHref(link.getAttribute('href'));
      if (addr) addrs.push(addr);
    }
    return [...new Set(addrs)];
  };

  const onBannerTick = async () => {
    try {
      const route = routeInfo();
      if (!route) {
        visibleBannerWins.clear();
        return;
      }
      const settings = await BBD.store.settings();
      if (!settings.advisorOnBanner || !settings.advisorEnabled || !configured(settings)) {
        visibleBannerWins.clear();
        return;
      }
      const current = new Set(bannerWinAddrs()
        .filter((addr) => sameAddr(addr, route.addr)));
      for (const addr of visibleBannerWins) {
        if (!current.has(addr)) visibleBannerWins.delete(addr);
      }
      const newWins = [...current].filter((addr) => !visibleBannerWins.has(addr));
      newWins.forEach((addr) => visibleBannerWins.add(addr));
      await Promise.all(newWins.map((addr) =>
        request(addr, { reason: 'banner', settings })));
    } catch (err) {
      // The banner remains useful even if its optional second opinion cannot run.
    }
  };

  const tick = () => {
    const route = routeInfo();
    if (!route) {
      const existing = document.getElementById('bbd-advisor');
      if (existing) existing.style.display = 'none';
      return;
    }
    const ui = ensureEl();
    if (ui.el.dataset.addr !== route.addr) {
      ui.el.dataset.addr = route.addr;
      ui.output.replaceChildren();
      ui.button.disabled = false;
    }
    ui.el.style.display = 'block';
    positionNearIntel(ui.el);
  };

  return {
    request,
    onDump,
    onBannerTick,
    tick,
    _bucket: bucket,
    _isFresh: isFresh
  };
})();
