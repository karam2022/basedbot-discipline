// Service worker: shows Chrome notifications (click opens the token page)
// and relays alerts to Telegram when a bot token + chat id are configured.
'use strict';

// MV3 service workers get killed between events, so nothing can live in
// memory: the token URL is encoded into the notification id itself.
const ID_PREFIX = 'bbd|';
const idFor = (url) => ID_PREFIX + (url || '');
const urlFrom = (id) => {
  if (!id.startsWith(ID_PREFIX)) return null;
  const url = id.slice(ID_PREFIX.length);
  return /^https:\/\/basedbot\.app\//.test(url) ? url : null;
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
});

chrome.notifications.onClicked.addListener((id) => {
  const url = urlFrom(id);
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(id);
});
