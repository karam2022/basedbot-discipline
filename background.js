// Service worker: shows Chrome notifications (click opens the token page)
// and relays alerts to Telegram when a bot token + chat id are configured.
'use strict';

// MV3 service workers get killed between events, so nothing can live in
// memory: the token URL is encoded into the notification id itself. A
// timestamp suffix keeps repeat alerts from silently replacing each other (#7).
const ID_PREFIX = 'bbd|';
const idFor = (url) => `${ID_PREFIX}${url || ''}|${Date.now()}`;
const urlFrom = (id) => {
  if (!id.startsWith(ID_PREFIX)) return null;
  const url = id.slice(ID_PREFIX.length).split('|')[0];
  return /^https:\/\/basedbot\.app\//.test(url) ? url : null;
};

// ---- Alert dedupe, single-writer (#1, #3) ---------------------------------
// All tabs funnel through this worker, and the promise chain serializes the
// read-modify-write so two tabs (or two positions in one tick) can't race.
// Entries: { [key]: { ts, pct? } } in storage key 'alerted'.
//  - hot:<addr>  → suppressed for 24h after an alert
//  - tp:<addr>   → re-alerts only when pct climbs refireStepPct, or after 24h
const DEDUPE_TTL_MS = 24 * 3600 * 1000;
let dedupeChain = Promise.resolve(false);

const shouldSendInner = async (dedupe) => {
  const store = await chrome.storage.local.get(['alerted', 'settings']);
  const alerted = store.alerted || {};
  const refireStep = (store.settings && store.settings.refireStepPct) || 10;
  const raw = alerted[dedupe.key];
  const prior = typeof raw === 'number' ? { ts: raw } : raw;
  if (prior && Date.now() - prior.ts < DEDUPE_TTL_MS) {
    const isTp = dedupe.key.startsWith('tp:');
    const climbed = isTp && typeof dedupe.pct === 'number' &&
      typeof prior.pct === 'number' && dedupe.pct >= prior.pct + refireStep;
    if (!climbed) return false;
  }
  const next = { ...alerted, [dedupe.key]: { ts: Date.now(), pct: dedupe.pct } };
  // Inline prune: keep the map bounded even if content-side housekeeping fails.
  const pruned = Object.fromEntries(
    Object.entries(next).filter(([, v]) => {
      const ts = typeof v === 'number' ? v : v && v.ts;
      return typeof ts === 'number' && Date.now() - ts < 3 * DEDUPE_TTL_MS;
    })
  );
  await chrome.storage.local.set({ alerted: pruned });
  return true;
};

const shouldSend = (dedupe) => {
  if (!dedupe || !dedupe.key) return Promise.resolve(true);
  dedupeChain = dedupeChain
    .catch(() => false)
    .then(() => shouldSendInner(dedupe));
  return dedupeChain;
};

// A common mistake is entering the bot's own id (the number before ':' in the
// token) as the chat id. Detect that — or an empty chat id — and self-heal by
// discovering the real chat from getUpdates (works once the user has messaged
// the bot), then persist the fix.
const resolveChatId = async (token, configured) => {
  const botId = token.split(':')[0];
  if (configured && configured !== botId) return configured;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    const data = await res.json();
    const upd = (data.result || []).reverse().find((u) => u.message && u.message.chat);
    if (!upd) return null;
    const discovered = String(upd.message.chat.id);
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, tgChatId: discovered } });
    console.log('[bbd] self-healed telegram chat id:', discovered);
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
    if (!token) return;
    const chatId = await resolveChatId(token, settings.tgChatId);
    if (!chatId) return;
    const text = `${msg.title}\n${msg.message}${msg.url ? '\n' + msg.url : ''}`;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!res.ok) console.warn('[bbd] telegram send failed', res.status);
  } catch (err) {
    console.warn('[bbd] telegram send failed', err);
  }
};

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'bbd-notify') return;
  (async () => {
    if (!(await shouldSend(msg.dedupe))) return;
    // target 'telegram' (🔥 best guesses) skips Chrome — desktop notifications
    // are reserved for take-profit alerts on held positions.
    if (msg.target !== 'telegram') {
      chrome.notifications.create(idFor(msg.url), {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: String(msg.title || 'BasedBot Discipline'),
        message: String(msg.message || ''),
        priority: 2
      });
    }
    sendTelegram(msg);
  })();
});

chrome.notifications.onClicked.addListener((id) => {
  const url = urlFrom(id);
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(id);
});
