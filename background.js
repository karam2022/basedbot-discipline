// MV3 service worker: reliable notifications, Telegram delivery and serialized
// whole-wallet position snapshots from all open BasedBot tabs.
'use strict';

const ID_PREFIX = 'bbd|';
const idFor = (url) => `${ID_PREFIX}${url || ''}|${Date.now()}`;
const urlFrom = (id) => {
  if (!id.startsWith(ID_PREFIX)) return null;
  const url = id.slice(ID_PREFIX.length).split('|')[0];
  return /^https:\/\/basedbot\.app\//.test(url) ? url : null;
};

const DEDUPE_TTL_MS = 24 * 3600 * 1000;

// ---- Hook intelligence (ETH mainnet, data: v4hooks.org public JSON) --------
// "New interesting" = young, named, multi-pool, moving — and NOT one of the
// established launchpad template families (those are infrastructure, not news).
const HOOKSDB_TTL_MS = 6 * 3600 * 1000;
const HOOK_TEMPLATE_FAMILIES =
  /^(FeeHook|UniversalKlik|ClankerHook|LivoSwap|Sa1tHook|EthCreatorFeeHook|QuoteAssetCreatorFeeHook|V4TaxHook|ERC1967Proxy)/i;

// Pure scorer over v4hooks.org hook_graph nodes — exposed on the global scope
// so the test harness can drive it directly.
const bbdScoreHooks = (nodes, nowMs, maxAgeDays = 21, topN = 10) => {
  const out = [];
  for (const n of nodes || []) {
    if (!n || !n.label || HOOK_TEMPLATE_FAMILIES.test(n.label)) continue;
    const pools = Number(n.pools) || 0;
    if (pools < 2) continue;
    if (n.status === 'dormant') continue;
    const firstTs = Date.parse(n.first || '');
    if (!Number.isFinite(firstTs)) continue;
    const ageDays = (nowMs - firstTs) / 86400000;
    if (ageDays > maxAgeDays || ageDays < 0) continue;
    const velocity = Number(n.velocity) || 0;
    const accel = Number(n.accel) || 0;
    const verified = n.verified === 'yes' || n.verified === true;
    const score = accel * 3 + velocity * 2 + pools * 0.5 +
      (maxAgeDays - ageDays) * 0.3 + (verified ? 2 : 0);
    out.push({
      address: n.id, name: n.label, pools, status: n.status || '?',
      velocity, accel, ageDays: Math.round(ageDays * 10) / 10, verified,
      callbacks: (n.callbacks || []).slice(0, 6), score: Math.round(score * 10) / 10
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, topN);
};

globalThis.bbdScoreHooks = bbdScoreHooks; // exposed for the test harness

const refreshHooksDb = async (force) => {
  const { hooksdb } = await chrome.storage.local.get('hooksdb');
  if (!force && hooksdb && Date.now() - hooksdb.ts < HOOKSDB_TTL_MS) return hooksdb;
  try {
    const res = await fetch('https://v4hooks.org/data/hook_graph.json');
    if (!res.ok) throw new Error(`hook feed HTTP ${res.status}`);
    const graph = await res.json();
    const items = bbdScoreHooks(graph.nodes || [], Date.now());
    const fresh = { ts: Date.now(), generatedAt: graph.generated_at || null, items };
    await chrome.storage.local.set({ hooksdb: fresh });
    return fresh;
  } catch (err) {
    console.warn('[bbd] hooksdb refresh failed', err);
    return hooksdb || { ts: 0, items: [], error: String(err && err.message || err) };
  }
};
let alertChain = Promise.resolve();
let positionSyncChain = Promise.resolve();

const canSend = async (dedupe) => {
  if (!dedupe || !dedupe.key) return true;
  const store = await chrome.storage.local.get(['alerted', 'settings']);
  const alerted = store.alerted || {};
  const refireStep = (store.settings && store.settings.refireStepPct) || 10;
  const raw = alerted[dedupe.key];
  const prior = typeof raw === 'number' ? { ts: raw } : raw;
  if (!prior || Date.now() - prior.ts >= DEDUPE_TTL_MS) return true;
  const isTp = dedupe.key.startsWith('tp:');
  return !!(isTp && typeof dedupe.pct === 'number' && typeof prior.pct === 'number' &&
    dedupe.pct >= prior.pct + refireStep);
};

// Mark only after the requested delivery channel succeeded. A Telegram outage
// must not suppress the alert for 24 hours.
const markSent = async (dedupe) => {
  if (!dedupe || !dedupe.key) return;
  const { alerted: raw } = await chrome.storage.local.get('alerted');
  const next = { ...(raw || {}), [dedupe.key]: { ts: Date.now(), pct: dedupe.pct } };
  const pruned = Object.fromEntries(Object.entries(next).filter(([, v]) => {
    const ts = typeof v === 'number' ? v : v && v.ts;
    return typeof ts === 'number' && Date.now() - ts < 3 * DEDUPE_TTL_MS;
  }));
  await chrome.storage.local.set({ alerted: pruned });
};

const resolveChatId = async (token, configured) => {
  const botId = token.split(':')[0];
  if (configured && configured !== botId) return configured;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    if (!res.ok) return null;
    const data = await res.json();
    const upd = (data.result || []).reverse().find((u) => u.message && u.message.chat);
    if (!upd) return null;
    const discovered = String(upd.message.chat.id);
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings || {}), tgChatId: discovered } });
    return discovered;
  } catch (err) {
    console.warn('[bbd] chat id discovery failed', err);
    return null;
  }
};

const sendTelegram = async (msg) => {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const token = settings && settings.tgToken;
    if (!token) return { ok: false, reason: 'Telegram bot token is missing' };
    const chatId = await resolveChatId(token, settings.tgChatId);
    if (!chatId) return { ok: false, reason: 'Chat ID not found — message the bot once' };
    const title = String(msg.title || 'BasedBot Discipline').slice(0, 120);
    const message = String(msg.message || '').slice(0, 1200);
    const url = /^https:\/\/basedbot\.app\//.test(msg.url || '') ? msg.url : '';
    const text = `${title}\n${message}${url ? '\n' + url : ''}`;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
    if (!res.ok) {
      console.warn('[bbd] telegram send failed', res.status);
      return { ok: false, reason: `Telegram returned ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[bbd] telegram send failed', err);
    return { ok: false, reason: err && err.message ? err.message : 'Telegram request failed' };
  }
};

const processNotification = async (msg) => {
  if (!(await canSend(msg.dedupe))) return { ok: true, skipped: true };

  let chromeOk = false;
  if (msg.target !== 'telegram') {
    try {
      await chrome.notifications.create(idFor(msg.url), {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: String(msg.title || 'BasedBot Discipline').slice(0, 120),
        message: String(msg.message || '').slice(0, 500),
        priority: 2
      });
      chromeOk = true;
    } catch (err) {
      console.warn('[bbd] chrome notification failed', err);
    }
  }

  const telegram = await sendTelegram(msg);
  const delivered = msg.target === 'telegram' ? telegram.ok : (chromeOk || telegram.ok);
  if (delivered) await markSent(msg.dedupe);
  return {
    ok: delivered,
    chrome: chromeOk,
    telegram: telegram.ok,
    reason: delivered ? undefined : telegram.reason || 'Notification delivery failed'
  };
};

const queueNotification = (msg) => {
  const task = alertChain.catch(() => undefined).then(() => processNotification(msg));
  alertChain = task.catch(() => undefined);
  return task;
};

const validAddr = (v) => typeof v === 'string' &&
  /^(0x[a-fA-F0-9]{6,}|[1-9A-HJ-NP-Za-km-z]{20,})$/.test(v);

const validatePositions = (raw) => {
  const out = {};
  const entries = Object.entries(raw && typeof raw === 'object' ? raw : {}).slice(0, 250);
  for (const [key, p] of entries) {
    if (!p || !validAddr(p.addr) || !Number.isFinite(p.pct)) continue;
    out[String(key).slice(0, 220)] = {
      positionKey: String(key).slice(0, 220),
      addr: p.addr,
      symbol: typeof p.symbol === 'string' ? p.symbol.slice(0, 48) : '',
      pct: p.pct,
      pnlUsd: Number.isFinite(p.pnlUsd) ? p.pnlUsd : null,
      valueUsd: Number.isFinite(p.valueUsd) && p.valueUsd >= 0 ? p.valueUsd : null,
      chain: typeof p.chain === 'string' ? p.chain.slice(0, 40).toLowerCase() : null,
      wallet: typeof p.wallet === 'string' ? p.wallet.slice(0, 80) : null,
      sourceTs: Number.isFinite(p.sourceTs) ? p.sourceTs : Date.now(),
      ts: Number.isFinite(p.sourceTs) ? p.sourceTs : Date.now()
    };
  }
  return out;
};

// The service worker is the single writer for API balance snapshots. A stale
// tab cannot overwrite a newer snapshot from another tab.
const syncPositions = (msg) => {
  const task = positionSyncChain.catch(() => undefined).then(async () => {
    const sourceTs = Number(msg.sourceTs);
    if (!Number.isFinite(sourceTs) || sourceTs <= 0) return { ok: false, reason: 'bad timestamp' };
    const state = await chrome.storage.local.get(['positions', 'positionsMeta']);
    const meta = state.positionsMeta || {};
    if (Number(meta.sourceTs) >= sourceTs) {
      return { ok: true, accepted: false, reason: 'older snapshot' };
    }
    const positions = validatePositions(msg.positions);
    const previous = state.positions || {};
    for (const [key, p] of Object.entries(positions)) {
      const prior = previous[key] || Object.values(previous).find((old) => old &&
        old.addr === p.addr && (!old.chain || !p.chain || old.chain === p.chain));
      const oldPeak = prior && Number.isFinite(prior.peakPct) ? prior.peakPct : p.pct;
      p.peakPct = Math.max(oldPeak, p.pct);
    }
    const positionsMeta = {
      source: 'balances-api',
      sourceTs,
      syncedTs: Date.now(),
      count: Object.keys(positions).length
    };
    await chrome.storage.local.set({ positions, positionsMeta });
    return { ok: true, accepted: true, previous, positions, positionsMeta };
  });
  positionSyncChain = task.catch(() => undefined);
  return task;
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'bbd-notify') {
    queueNotification(msg).then(sendResponse).catch((err) => sendResponse({ ok: false, reason: err.message }));
    return true;
  }
  if (msg.type === 'bbd-test-telegram') {
    sendTelegram({
      title: '✅ BasedBot Discipline connected',
      message: 'Telegram alerts are working.'
    }).then(sendResponse).catch((err) => sendResponse({ ok: false, reason: err.message }));
    return true;
  }
  if (msg.type === 'bbd-hooksdb') {
    refreshHooksDb(Boolean(msg.force)).then(sendResponse);
    return true;
  }
  if (msg.type === 'bbd-sync-positions') {
    syncPositions(msg).then(sendResponse).catch((err) => sendResponse({ ok: false, reason: err.message }));
    return true;
  }
  return false;
});

chrome.notifications.onClicked.addListener((id) => {
  const url = urlFrom(id);
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(id);
});
