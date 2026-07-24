// Pure allow-list at the external-model boundary: no page state, I/O, or raw rows.
'use strict';

BBD.features = (() => {
  const MAX_REASONS = 8;
  const MAX_REASON_LENGTH = 160;

  const record = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

  const read = (source, key) => {
    try {
      return record(source) || Array.isArray(source) ? source[key] : undefined;
    } catch (err) {
      return undefined;
    }
  };

  const finite = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  const rounded = (value, decimals) => {
    const n = finite(value);
    if (n === null) return null;
    try {
      return Number(n.toFixed(decimals));
    } catch (err) {
      return null;
    }
  };

  const whole = (value) => {
    const n = finite(value);
    return n === null ? null : Math.round(n);
  };

  const count = (value) => {
    const n = finite(value);
    return n !== null && n >= 0 ? Math.round(n) : null;
  };

  const shortString = (value, maxLength) => {
    if (typeof value !== 'string') return null;
    try {
      const text = value.trim();
      return text ? text.slice(0, maxLength) : null;
    } catch (err) {
      return null;
    }
  };

  const bool = (value) => typeof value === 'boolean' ? value : null;

  const preferredNumber = (primary, primaryKey, fallback, fallbackKey) => {
    const first = finite(read(primary, primaryKey));
    return first !== null ? first : finite(read(fallback, fallbackKey));
  };

  const preferredBoolean = (primary, primaryKey, fallback, fallbackKey) => {
    const first = bool(read(primary, primaryKey));
    return first !== null ? first : bool(read(fallback, fallbackKey));
  };

  const reasonString = (value) => {
    if (typeof value === 'string') return shortString(value, MAX_REASON_LENGTH);
    if (typeof value === 'number') {
      return Number.isFinite(value) ? String(value).slice(0, MAX_REASON_LENGTH) : null;
    }
    if (typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value).slice(0, MAX_REASON_LENGTH);
    }
    return null;
  };

  const reasons = (value) => {
    if (!Array.isArray(value)) return null;
    const out = [];
    // A bounded scan prevents a malformed sparse array from becoming work at
    // the privacy boundary; objects are skipped rather than stringified.
    const inspected = Math.min(value.length, MAX_REASONS * 4);
    for (let i = 0; i < inspected && out.length < MAX_REASONS; i++) {
      const text = reasonString(read(value, i));
      if (text !== null) out.push(text);
    }
    return out;
  };

  const setNumber = (target, key, value, rounder) => {
    const n = rounder(value);
    if (n !== null) target[key] = n;
  };

  const setBoolean = (target, key, value) => {
    const state = bool(value);
    if (state !== null) target[key] = state;
  };

  const attach = (target, key, section) => {
    if (Object.keys(section).length) target[key] = section;
  };

  // Missing and null values stay absent. Explicit booleans, including false,
  // and explicitly supplied empty reason lists remain because they carry state.
  const build = (input) => {
    try {
      if (!record(input)) return {};

      const snapshot = {};
      const marketInput = read(input, 'market');
      const stats = read(input, 'stats');
      const intel = read(input, 'intel');
      const auditInput = read(input, 'audit');
      const creatorInput = read(input, 'creator');
      const flowInput = read(input, 'flow');
      const priceInput = read(input, 'priceChanges');
      const positionInput = read(input, 'position');
      const rulesInput = read(input, 'rules');

      const symbol = shortString(read(input, 'symbol'), 32) ||
        shortString(read(marketInput, 'symbol'), 32);
      const chain = shortString(read(input, 'chain'), 32);
      if (symbol !== null) snapshot.symbol = symbol;
      if (chain !== null) snapshot.chain = chain;
      setNumber(snapshot, 'ageHours', read(input, 'ageHours'), (value) => rounded(value, 1));

      const market = {};
      setNumber(market, 'mcapUsd', read(marketInput, 'mcap'), whole);
      setNumber(market, 'liqUsd', read(marketInput, 'liq'), whole);
      setBoolean(market, 'isLaunchpad', read(marketInput, 'isLaunchpad'));
      attach(snapshot, 'market', market);

      const safety = {};
      setNumber(safety, 'top10', preferredNumber(intel, 'top10', stats, 'top10'),
        (value) => rounded(value, 1));
      setNumber(safety, 'dev', preferredNumber(intel, 'dev', stats, 'dev'),
        (value) => rounded(value, 1));
      setNumber(safety, 'snipers', preferredNumber(intel, 'snipers', stats, 'snipers'),
        (value) => rounded(value, 1));
      setNumber(safety, 'insiders', preferredNumber(intel, 'insiders', stats, 'insiders'),
        (value) => rounded(value, 1));
      setNumber(safety, 'bundlers', preferredNumber(intel, 'bundlers', stats, 'bundlers'),
        (value) => rounded(value, 1));
      setNumber(safety, 'holders', preferredNumber(intel, 'holders', stats, 'holders'), count);
      setNumber(safety, 'proTraders', preferredNumber(intel, 'proTraders', stats, 'pro'), count);
      setBoolean(safety, 'dexPaid',
        preferredBoolean(intel, 'dexPaid', stats, 'paid'));
      setNumber(safety, 'lpBurned', read(intel, 'lpBurned'),
        (value) => rounded(value, 1));
      setBoolean(safety, 'renounced', read(intel, 'renounced'));
      // The current panel parser calls these buyTax/sellTax; accepting both
      // spellings keeps this boundary compatible without exposing either raw object.
      setNumber(safety, 'taxBuy',
        preferredNumber(intel, 'taxBuy', intel, 'buyTax'),
        (value) => rounded(value, 1));
      setNumber(safety, 'taxSell',
        preferredNumber(intel, 'taxSell', intel, 'sellTax'),
        (value) => rounded(value, 1));
      attach(snapshot, 'safety', safety);

      const audit = {};
      setBoolean(audit, 'danger', read(auditInput, 'danger'));
      setBoolean(audit, 'critical', read(auditInput, 'critical'));
      const auditReasons = reasons(read(auditInput, 'reasons'));
      if (auditReasons !== null) audit.reasons = auditReasons;
      attach(snapshot, 'audit', audit);

      const creator = {};
      setNumber(creator, 'priorTokens', read(creatorInput, 'launchCount'), count);
      setNumber(creator, 'priorRugs', read(creatorInput, 'ruggedCount'), count);
      setBoolean(creator, 'flagged', read(creatorInput, 'flagged'));
      attach(snapshot, 'creator', creator);

      const flow = {};
      setNumber(flow, 'windowMin', read(flowInput, 'windowMin'),
        (value) => rounded(value, 1));
      setNumber(flow, 'buyRatio', read(flowInput, 'buyRatio'),
        (value) => rounded(value, 2));
      setNumber(flow, 'uniqueBuyers', read(flowInput, 'uniqueBuyers'), count);
      setNumber(flow, 'uniqueSellers', read(flowInput, 'uniqueSellers'), count);
      setNumber(flow, 'top3TraderShare', read(flowInput, 'top3TraderShare'),
        (value) => rounded(value, 2));
      setNumber(flow, 'proTraderNetUsd', read(flowInput, 'proTraderNetUsd'), whole);
      setNumber(flow, 'sniperNetUsd', read(flowInput, 'sniperNetUsd'), whole);
      setBoolean(flow, 'devSold', read(flowInput, 'devSold'));
      setNumber(flow, 'volumeTrend', read(flowInput, 'volumeTrend'),
        (value) => rounded(value, 2));
      attach(snapshot, 'flow', flow);

      const price = {};
      setNumber(price, 'changePct1m', read(priceInput, 'changePct1m'),
        (value) => rounded(value, 1));
      setNumber(price, 'changePct5m', read(priceInput, 'changePct5m'),
        (value) => rounded(value, 1));
      setNumber(price, 'changePct15m', read(priceInput, 'changePct15m'),
        (value) => rounded(value, 1));
      attach(snapshot, 'price', price);

      const position = {};
      setBoolean(position, 'held', read(positionInput, 'held'));
      setNumber(position, 'pnlPct', read(positionInput, 'pnlPct'),
        (value) => rounded(value, 1));
      setNumber(position, 'peakPct', read(positionInput, 'peakPct'),
        (value) => rounded(value, 1));
      attach(snapshot, 'position', position);

      const rules = {};
      setNumber(rules, 'score', read(rulesInput, 'score'), whole);
      setBoolean(rules, 'hot', read(rulesInput, 'hot'));
      setBoolean(rules, 'gem', read(rulesInput, 'gem'));
      const hideReasons = reasons(read(rulesInput, 'hideReasons'));
      if (hideReasons !== null) rules.hideReasons = hideReasons;
      attach(snapshot, 'rules', rules);

      return snapshot;
    } catch (err) {
      return {};
    }
  };

  return { build };
})();
