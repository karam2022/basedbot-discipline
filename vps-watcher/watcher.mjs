// BasedBot watcher — runs headless on a VPS, no wallet needed (Pulse is
// public). Scans every intervalSec, Telegrams tiered alerts:
//   🔥 best guess   — passes every safety gate + strong utility evidence
//   💎 possible gem — passes every safety gate + website, thinner proof
//   🚀 momentum     — ANY token (memes included) entering the mcap band
//   🌱 new utility  — brand-new, has real web presence, not a name-replica,
//                     regardless of mcap/liquidity/stats
// Every alert carries a "Track" button; tracked tokens get an exit watch
// (⚠️ when holders bleed or holder structure deteriorates).
'use strict';

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(ROOT, 'config.json');
const SEEN_PATH = join(ROOT, 'seen.json');
const NAMES_PATH = join(ROOT, 'names.json');     // replica registry
const TRACKED_PATH = join(ROOT, 'tracked.json'); // user-tracked tokens
const OFFSET_PATH = join(ROOT, 'tg-offset.json');
const WATCH_PATH = join(ROOT, 'watchwords.json'); // { word: { ts } }
// Canonical hot-logic config, shared with the extension (memeBadges/keywords/
// socialWeights/hotGates). Read here so the watcher can't drift from the
// extension — test/config-sync.test.js fails if the JSON and constants diverge.
const HOT_CONFIG_PATH = join(ROOT, '..', 'shared', 'hot-config.json');

const loadJson = (path, fallback) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  } catch (err) {
    console.error(`[watcher] bad JSON in ${path}:`, err.message);
    return fallback;
  }
};
const saveJson = (path, data) => writeFileSync(path, JSON.stringify(data, null, 1));

const config = loadJson(CONFIG_PATH, {});
const HOT_CONFIG = loadJson(HOT_CONFIG_PATH, null);
if (!HOT_CONFIG) {
  console.error(`[watcher] missing ${HOT_CONFIG_PATH} — cannot score without the shared hot-config.`);
  process.exit(1);
}
const CHAINS = config.chains || ['robinhood'];
const INTERVAL_MS = (config.intervalSec || 30) * 1000;
const RELOAD_MS = (config.reloadMin || 30) * 60 * 1000;
const TG_TOKEN = config.tgToken || '';
let tgChatId = config.tgChatId || '';
const REALERT_MS = (config.realertHours || 24) * 3600 * 1000;
// 🚀 momentum band (memes welcome — size is the signal)
const BAND_MIN = config.bandMinUsd || 100000;
const BAND_MAX = config.bandMaxUsd || 200000;
// 🌱 new-utility tier
const NEW_MAX_AGE_MIN = config.newMaxAgeMin || 60;
const REPLICA_TTL_MS = (config.replicaDays || 7) * 24 * 3600 * 1000;
// exit watch
const EXIT_CHECK_MS = (config.exitCheckMin || 5) * 60 * 1000;
const EXIT_HOLDER_DROP_PCT = config.exitHolderDropPct || 15;
const EXIT_STRUCT_RISE_PTS = config.exitStructRisePts || 10;
const TRACK_TTL_MS = (config.trackTtlDays || 7) * 24 * 3600 * 1000;
const CHAIN_IDS = { robinhood: 4663, base: 8453, ethereum: 1, solana: 0 };

if (!TG_TOKEN) console.error('[watcher] tgToken missing in config.json — alerts will NOT send.');

// Optional local plugin: if a plugin.mjs sits alongside this file, load it and
// forward scan events. Not shipped in the repo — a private extension point.
let plugin = null;

// ---------------------------------------------------------------- telegram --
const tg = async (method, payload) => {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) console.error(`[watcher] telegram ${method} error`, res.status, JSON.stringify(j).slice(0, 120));
    return j;
  } catch (err) {
    console.error(`[watcher] telegram ${method} failed`, err.message);
    return null;
  }
};

let tgFirehoseChatId = config.tgFirehoseChatId || '';
let tgTrackingChatId = config.tgTrackingChatId || '';
let tgQualityChatId = config.tgQualityChatId || ''; // defaults to the owner DM
// dest: 'quality' (default, your main chat) or 'firehose' (high-volume tiers).
// Without a firehose chat configured, everything goes to the main chat.
const sendTelegram = async (text, buttons, dest = 'quality') => {
  const chat = dest === 'firehose' && tgFirehoseChatId ? tgFirehoseChatId
    : dest === 'tracking' && tgTrackingChatId ? tgTrackingChatId
      : (tgQualityChatId || tgChatId);
  if (!TG_TOKEN || !chat) return false;
  const payload = { chat_id: chat, text, disable_web_page_preview: true };
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };
  const j = await tg('sendMessage', payload);
  return Boolean(j && j.ok);
};

// The command menu Telegram shows when you type "/". Without setMyCommands the
// bot advertises nothing, so there's no autocomplete — that's the whole reason
// the groups felt uncontrollable. Registered on every startup (idempotent).
const CMD_LIST = [
  { command: 'help', description: 'Show every command + what this chat does' },
  { command: 'track', description: 'Watch a token for exit signals — /track 0x…' },
  { command: 'untrack', description: 'Stop watching a token — /untrack 0x…' },
  { command: 'tracklist', description: 'List tokens under exit watch' },
  { command: 'watch', description: 'Alert on new tokens by name — /watch GUSH' },
  { command: 'unwatch', description: 'Remove a watchword — /unwatch GUSH' },
  { command: 'watchlist', description: 'Show your watchwords' },
  { command: 'tracking', description: 'Bind THIS chat as the Tracking channel' },
  { command: 'firehose', description: 'Bind THIS chat as the Firehose channel' },
  { command: 'quality', description: 'Bind THIS chat as the Quality channel' }
];
// A private plugin may add its own commands (menu) + a /help section. The
// public build has no plugin, so its menu stays exactly the list above.
const HELP_TEXT = (role, extra = '') => `🤖 BasedBot — what I can do

📍 EXIT WATCH (Tracking chat)
/track 0x… — watch a token, warn me if it bleeds
/untrack 0x… — stop watching one
/tracklist — what's under exit watch right now

🔔 WATCHWORDS (any chat)
/watch GUSH — ping me on any new token named GUSH
/unwatch GUSH — remove it
/watchlist — show them
${extra ? '\n' + extra + '\n' : ''}
⚙️ SETUP — run inside the chat you want it to be
/tracking · /firehose · /quality

You can also press 📍 Track on any alert instead of typing /track.

This chat is: ${role}`;

const registerCommands = async () => {
  if (!TG_TOKEN) return;
  const commands = [...CMD_LIST, ...((plugin && plugin.commands) || [])];
  // Set the menu at three scopes so it shows in private chats, every group
  // (bound or not — that's how you discover /quality to bind it), and default.
  for (const scope of [{ type: 'default' }, { type: 'all_private_chats' }, { type: 'all_group_chats' }]) {
    await tg('setMyCommands', { commands, scope });
  }
  console.log(`[watcher] telegram command menu registered (${commands.length} commands)`);
};

// Single consumer of getUpdates: handles chat discovery AND Track buttons.
let polling = false;
const pollUpdates = async () => {
  if (!TG_TOKEN || polling) return; // single getUpdates consumer — never overlap
  polling = true;
  try {
    await pollUpdatesInner();
  } finally {
    polling = false;
  }
};
const pollUpdatesInner = async () => {
  const off = loadJson(OFFSET_PATH, { offset: 0 });
  const j = await tg('getUpdates', {
    offset: off.offset, timeout: 0,
    allowed_updates: ['message', 'callback_query']
  });
  if (!j || !j.ok || !Array.isArray(j.result) || !j.result.length) return;
  for (const u of j.result) {
    off.offset = u.update_id + 1;
    const txt = (u.message && u.message.text || '').trim().toLowerCase();
    if (u.message && u.message.chat && txt.startsWith('/')) {
      const fromChat = String(u.message.chat.id);
      const reply = (text) => tg('sendMessage', { chat_id: u.message.chat.id, text, disable_web_page_preview: true });
      const cmd0 = txt.split(/\s+/)[0].split('@')[0];
      // /help works from ANY chat — it's how you discover everything else.
      if (cmd0 === '/help') {
        const role = fromChat === String(tgTrackingChatId) ? 'Tracking 📍 (discipline + exit watch)'
          : fromChat === String(tgFirehoseChatId) ? 'Firehose 🌊 (high-volume tiers)'
            : fromChat === String(tgQualityChatId) ? 'Quality 🏆 (rare high-conviction)'
              : fromChat === String(tgChatId) ? 'your Owner DM'
                : 'NOT BOUND yet — run /tracking, /firehose, or /quality here';
        await reply(HELP_TEXT(role, (plugin && plugin.helpSection) || ''));
        continue;
      }
      // Commands only from bound chats — anyone can message a bot, and the
      // watchlist must not be writable by strangers. (bind commands are exempt:
      // binding a new chat is the one thing that must work from anywhere.)
      const bound = [tgChatId, tgFirehoseChatId, tgTrackingChatId, tgQualityChatId]
        .some((id) => id && fromChat === String(id));
      // A bind command may come from a new (unbound) group, but only from the
      // OWNER: in a private chat, chat id == user id, so tgChatId doubles as owner id.
      const fromOwner = String(u.message.from && u.message.from.id) === String(tgChatId);
      const isBindCmd = cmd0 === '/firehose' || cmd0 === '/tracking' || cmd0 === '/quality';
      if (!bound && !(isBindCmd && fromOwner)) {
        // Don't fail silently at the OWNER — tell them the chat needs setup.
        // Strangers still get silence (no spam, no reveal).
        if (fromOwner) await reply('⚠️ This chat isn\'t set up yet, so I ignore commands here. Run /quality, /tracking, or /firehose in THIS chat once to bind it — then every command works and replies.');
        continue;
      }
      const [cmdRaw, ...args] = txt.split(/\s+/);
      const cmd = cmdRaw.split('@')[0];
      if (cmd === '/watch') {
        if (!args.length) {
          await reply('Usage: /watch GUSH — I\'ll alert on any new token whose name contains that word. /watchlist to see them.');
          continue;
        }
        const words = loadJson(WATCH_PATH, {});
        for (const w of args.slice(0, 10)) {
          const key = w.replace(/[^a-z0-9]/g, '');
          if (key.length >= 2 && key.length <= 30) words[key] = { ts: Date.now() };
        }
        saveJson(WATCH_PATH, words);
        await reply(`🔔 Watching: ${Object.keys(words).join(', ')}\nI'll alert on ANY new listing whose name or symbol contains a watchword — including fakes launched before an official token, so verify each against the project's own socials.`);
        continue;
      }
      if (cmd === '/unwatch') {
        const words = loadJson(WATCH_PATH, {});
        if (!args.length) {
          await reply(`Usage: /unwatch GUSH. Currently watching: ${Object.keys(words).join(', ') || '(none)'}`);
          continue;
        }
        let removed = 0;
        for (const w of args) { const k = w.replace(/[^a-z0-9]/g, ''); if (words[k]) { delete words[k]; removed += 1; } }
        saveJson(WATCH_PATH, words);
        await reply(`✅ Removed ${removed}. Watchlist now: ${Object.keys(words).join(', ') || '(empty)'}`);
        continue;
      }
      if (cmd === '/track' && args.length) {
        const addr = args[0];
        if (!/^0x[a-f0-9]{6,}$/.test(addr)) {
          await reply('Give me a token address: /track 0x…  (or just press 📍 Track on an alert).');
          continue;
        }
        const chain = CHAINS[0];
        const tracked = loadJson(TRACKED_PATH, {});
        tracked[addr] = { chain, ts: Date.now(), baseline: null, peakHolders: 0, lastExitAlert: 0 };
        saveJson(TRACKED_PATH, tracked);
        await reply(`📍 Tracking ${addr.slice(0, 12)}… on ${chain}. I'll warn you if holders bleed or the holder structure deteriorates. Auto-untracks in ${Math.round(TRACK_TTL_MS / 86400000)}d.`);
        continue;
      }
      if (cmd === '/untrack' && args.length) {
        const tracked = loadJson(TRACKED_PATH, {});
        let n = 0;
        for (const a of args) if (tracked[a]) { delete tracked[a]; n += 1; }
        saveJson(TRACKED_PATH, tracked);
        await reply(`Untracked ${n}. Still watching: ${Object.keys(tracked).length}.`);
        continue;
      }
      if (cmd === '/tracklist') {
        const tracked = loadJson(TRACKED_PATH, {});
        const keys = Object.keys(tracked);
        await reply(keys.length
          ? `📍 Under exit watch (${keys.length}):\n${keys.map((a) => `  ${a.slice(0, 14)}… (${tracked[a].chain})`).join('\n')}`
          : '📍 Nothing tracked yet. Press 📍 Track on an alert, or /track 0x…');
        continue;
      }
      if (plugin && plugin.onCommand && await plugin.onCommand(cmd, args, reply)) continue;
      if (cmd === '/watchlist') {
        const words = loadJson(WATCH_PATH, {});
        await reply(`🔔 Watchwords: ${Object.keys(words).join(', ') || '(none — add with /watch TOKEN)'}`);
        continue;
      }
    }
    if (u.message && u.message.chat && txt.split('@')[0] === '/quality') {
      tgQualityChatId = String(u.message.chat.id);
      saveJson(CONFIG_PATH, { ...config, tgChatId, tgFirehoseChatId, tgTrackingChatId, tgQualityChatId });
      await tg('sendMessage', { chat_id: tgQualityChatId, text: '🏆 This chat is now QUALITY — the rare, high-conviction alerts land here: 🔥 best guesses, 🌱👑 strict utility, strong 💎, and 🔔 your watchwords. Expect a handful a day, not a stream.' });
      console.log(`[watcher] quality chat bound: ${tgQualityChatId}`);
      continue;
    }
    if (u.message && u.message.chat && txt.split('@')[0] === '/tracking') {
      tgTrackingChatId = String(u.message.chat.id);
      saveJson(CONFIG_PATH, { ...config, tgChatId, tgFirehoseChatId, tgTrackingChatId });
      await tg('sendMessage', { chat_id: tgTrackingChatId, text: '📍 This chat is now TRACKING — Track confirmations, ⚠️ exit warnings, and 🏁 auto-untracks land here.' });
      console.log(`[watcher] tracking chat bound: ${tgTrackingChatId}`);
      continue;
    }
    if (u.message && u.message.chat && txt.split('@')[0] === '/firehose') {
      tgFirehoseChatId = String(u.message.chat.id);
      saveJson(CONFIG_PATH, { ...config, tgChatId, tgFirehoseChatId });
      await tg('sendMessage', { chat_id: tgFirehoseChatId, text: '🌊 This chat is now the FIREHOSE — high-volume tiers (💎 basic, 🚀 momentum, 🌱 basic) land here. Your main chat keeps only 🔥, strict 🌱👑, strong 💎, and exit warnings.' });
      console.log(`[watcher] firehose chat bound: ${tgFirehoseChatId}`);
      continue;
    }
    if (u.message && u.message.chat && !tgChatId) {
      tgChatId = String(u.message.chat.id);
      saveJson(CONFIG_PATH, { ...config, tgChatId });
      console.log(`[watcher] discovered chat id ${tgChatId}`);
      await sendTelegram('✅ BasedBot watcher connected. Tiered alerts will arrive here: 🔥 💎 🚀 🌱');
    }
    if (u.callback_query) await handleCallback(u.callback_query);
  }
  saveJson(OFFSET_PATH, off);
};

const handleCallback = async (cq) => {
  const data = cq.data || '';
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: cq.id, text });
  if (data.startsWith('trk:')) {
    const [, chain, addr] = data.split(':');
    if (!chain || !addr) return answer('Bad data');
    const tracked = loadJson(TRACKED_PATH, {});
    tracked[addr] = {
      chain, ts: Date.now(),
      baseline: null, peakHolders: 0, lastExitAlert: 0
    };
    saveJson(TRACKED_PATH, tracked);
    console.log(`[watcher] tracking ${addr} on ${chain}`);
    await answer('📍 Tracking — exit watch armed');
    await sendTelegram(`📍 Now tracking ${addr.slice(0, 10)}… on ${chain}. I'll warn you if holders bleed or the holder structure deteriorates. Auto-untracks in ${Math.round(TRACK_TTL_MS / 86400000)}d.`, null, 'tracking');
  } else if (data === 'ign') {
    await answer('Ignored');
  }
};

// ---------------------------------------------------------------- parsing ---
// Runs inside the page: a PURE parser. All tier logic lives in Node, so the
// page function stays simple and the scoring is testable server-side.
const scanPage = () => {
  const addrOf = (h) => {
    const m = (h || '').match(/\/token\/[^/]+\/(0x[a-fA-F0-9]{6,}|[1-9A-HJ-NP-Za-km-z]{20,})/);
    if (!m) return null;
    return m[1].startsWith('0x') ? m[1].toLowerCase() : m[1];
  };
  const cards = [...document.querySelectorAll('a[href*="/token/"]')]
    .filter((a) => addrOf(a.getAttribute('href')));
  const out = [];
  let withStats = 0;
  for (const c of cards) {
    const leaves = [...c.querySelectorAll('span,div')]
      .filter((e) => e.childElementCount === 0)
      .map((e) => e.textContent.trim()).filter(Boolean);
    const alts = [...c.querySelectorAll('img')].map((i) => (i.alt || '').trim()).filter(Boolean);
    const titles = [...c.querySelectorAll('[title]')]
      .map((e) => (e.getAttribute('title') || '').trim()).filter(Boolean);
    // positional stats (layout canary: reject unrecognized shapes)
    const pctNum = (t) => (t.startsWith('<') ? 0.5 : Number(t.replace('%', '')));
    const countNum = (t) => {
      const m = t.match(/^([\d.]+)(K|M)?$/);
      return m ? Number(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1) : null;
    };
    let stats = null;
    const pctIdx = leaves.map((t, i) => (/^<?\d+(\.\d+)?%$/.test(t) ? i : -1)).filter((i) => i >= 0);
    if (pctIdx.length >= 5 && pctIdx.length <= 8) {
      const l5 = pctIdx.slice(-5);
      const [top10, dev, snipers, bundlers, insiders] = l5.map((i) => pctNum(leaves[i]));
      const holders = countNum(leaves[l5[0] - 2] || '');
      const pro = countNum(leaves[l5[0] - 1] || '');
      if (holders !== null && pro !== null &&
        [top10, dev, snipers, bundlers, insiders].every((v) => v >= 0 && v <= 100)) {
        stats = { holders, pro, top10, dev, snipers, bundlers, insiders, paid: leaves.includes('Paid') };
        withStats += 1;
      }
    }
    // First alt that is NOT a DEX/launchpad badge — cards with a blank logo
    // alt otherwise report their symbol as "Uniswap V4".
    const NOT_SYMBOL = ['Uniswap V2', 'Uniswap V3', 'Uniswap V4', 'Virtual', 'Pons', 'bow.fun',
      'Flap', 'Circus', 'Charms', 'Long.xyz', 'Bankr', 'Ape Store', 'Zora', 'Clanker', 'Flaunch',
      'Stroid', 'Klik', 'Trench', 'Livo', 'Pump.fun', 'PumpFun', 'PumpSwap', 'Bags', 'Meteora DBC'];
    const symbol = alts.find((a) => !NOT_SYMBOL.includes(a)) || '';
    const symIdx = leaves.indexOf(symbol);
    let name = symIdx >= 0 ? (leaves[symIdx + 1] || '') : '';
    if (name === 'OG') name = leaves[symIdx + 2] || ''; // OG badge sits between symbol and name
    if (name.startsWith('/') || name === symbol || NOT_SYMBOL.includes(name)) name = '';
    const after = (label) => {
      const i = leaves.indexOf(label);
      return i >= 0 ? (leaves[i + 1] || '') : '';
    };
    out.push({
      addr: addrOf(c.getAttribute('href')),
      symbol, name,
      badges: alts.slice(1),
      titles,
      blob: (c.textContent || '').slice(0, 40).toLowerCase(),
      age: leaves.find((t) => /^\d+(?:\.\d+)?[smhd]$/.test(t)) || '',
      mc: after('MC'), vol: after('V'), tx: after('TX'),
      stats
    });
  }
  return { cards: out, cardCount: cards.length, withStats };
};

// --------------------------------------------------------------- scoring ----
// All hot-logic lists come from the shared config so the watcher and the
// extension score identically (single source of truth: shared/hot-config.json).
const PADS = HOT_CONFIG.memeBadges;
const SW = HOT_CONFIG.socialWeights;
const UTILITY_TITLES = Object.keys(SW).filter((k) => SW[k] > 0);
const KW = HOT_CONFIG.memeKeywords;
const AMB = HOT_CONFIG.ambiguousKeywords;
const GATES = HOT_CONFIG.hotGates;

const hasKw = (t) => KW.some((kw) => AMB.includes(kw)
  ? new RegExp(`(^|[^a-z0-9])${kw}([^a-z0-9]|$)`, 'i').test(t)
  : t.includes(kw));
const moneyNum = (t) => {
  const m = (t || '').replace(/[$,]/g, '').match(/^([\d.]+)([KMB])?$/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return Number(m[1]) * mult;
};
const ageMin = (t) => {
  const m = (t || '').match(/^([\d.]+)([smhd])$/);
  if (!m) return null;
  return Number(m[1]) * { s: 1 / 60, m: 1, h: 60, d: 1440 }[m[2]];
};
const normToken = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const socialScore = (card) => {
  let s = 0;
  if (card.badges.some((b) => PADS.includes(b))) s -= 3;
  if (card.badges.includes('Virtual')) s += 1;
  if (hasKw(card.blob)) s -= 3;
  card.titles.forEach((t) => { if (typeof SW[t] === 'number') s += SW[t]; });
  return s;
};

const safetyPass = (s) => {
  if (!s || !s.paid) return false;
  const ratio = s.holders > 0 ? s.pro / s.holders : 0;
  return s.top10 <= GATES.top10 && s.dev <= GATES.dev &&
    s.snipers <= GATES.snipers && s.bundlers <= GATES.bundlers &&
    s.insiders <= GATES.insiders && s.holders >= GATES.holders &&
    ratio >= 0.05 && ratio <= 0.6;
};

// Replica check: a token whose symbol OR name matches a recently seen launch
// under a different address is a copy, not a new idea (the $MISSPELED trap).
const replicaCheck = (card, names) => {
  const now = Date.now();
  let replica = false;
  for (const key of [normToken(card.symbol), normToken(card.name)]) {
    if (!key || key.length < 3) continue;
    const prior = names[key];
    if (prior && prior.addr !== card.addr && now - prior.ts < REPLICA_TTL_MS) replica = true;
    if (!prior) names[key] = { addr: card.addr, ts: now };
  }
  return replica;
};

// --------------------------------------------------------------- alerts -----
const sanitizeAlertText = (text, maxLen = 48) => {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/(?:https?:\/\/|www\.|t\.me\/|@)\S+/gi, '')
    .replace(/\S+\.(?:com|io|net|org|app|xyz|fun|finance|trade|money|st)\b\S*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
};

// ------------------------------------------------------- enrichment ---------
// Metadata API (shape captured from page traffic): fills real symbol/name and
// social links — cards with blank logo alts otherwise have no usable name.
const fetchMetadata = async (chain, addrs) => {
  const page = pages.get(chain);
  if (!page || !addrs.length) return {};
  try {
    const res = await page.evaluate(async ({ addrs, chainId }) => {
      const r = await fetch('/api/tokens/metadata', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokens: addrs.map((a) => ({ address: a, chain: chainId })) })
      });
      if (!r.ok) return {};
      const j = await r.json().catch(() => null);
      return (j && j.data) || {};
    }, { addrs, chainId: CHAIN_IDS[chain] || 0 });
    const map = {};
    for (const [k, v] of Object.entries(res)) {
      map[k.replace(/-\d+$/, '').toLowerCase()] = v;
    }
    return map;
  } catch (err) {
    console.error(`[watcher] metadata fetch failed on ${chain}:`, err.message.slice(0, 60));
    return {};
  }
};

// Website peek: the project describing itself. Title + meta description go
// into the alert so the human judges utility in two seconds; a dead site
// disqualifies 🌱 outright (fake web presence), and a domain unrelated to the
// token name gets flagged (link-borrowing — memes pointing at real projects).
const siteCache = new Map(); // url -> { ok, line, ts }
const SITE_CACHE_MS = 24 * 3600 * 1000;
const sitePeek = async (url) => {
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, line: '' };
  const hit = siteCache.get(url);
  if (hit && Date.now() - hit.ts < SITE_CACHE_MS) return hit;
  let out = { ok: false, line: 'website unreachable', ts: Date.now() };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    clearTimeout(t);
    if (r.ok) {
      const html = (await r.text()).slice(0, 40000);
      const pick = (re) => {
        const m = html.match(re);
        return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').trim() : '';
      };
      const title = pick(/<title[^>]*>([^<]{2,120})/i);
      const desc = pick(/<meta[^>]+(?:name="description"|property="og:description")[^>]+content="([^"]{2,200})"/i)
        || pick(/<meta[^>]+content="([^"]{2,200})"[^>]+(?:name="description"|property="og:description")/i);
      const line = sanitizeAlertText([title, desc].filter(Boolean).join(' · '), 170);
      out = { ok: true, line: line || '(site loads, no self-description)', ts: Date.now() };
    }
  } catch (err) { /* stays unreachable */ }
  siteCache.set(url, out);
  return out;
};

const PLATFORM_HOSTS = ['github.com', 'gitbook.io', 'notion.site', 'notion.so', 'linktr.ee',
  'medium.com', 'substack.com', 'vercel.app', 'netlify.app', 'webflow.io', 'carrd.co'];
const domainMatchesToken = (url, symbol, name) => {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    // On platform hosts the project's identity is the path (github.com/RobinhoodCoin),
    // not the domain — comparing against "github" would flag every real repo.
    const candidate = PLATFORM_HOSTS.some((h) => host === h || host.endsWith('.' + h))
      ? (u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase()
      : host.split('.')[0];
    const cand = candidate.replace(/[^a-z0-9]/g, '');
    if (!cand) return true;
    const toks = [normToken(symbol), normToken(name)].filter((t) => t && t.length >= 3);
    return toks.some((t) => cand.includes(t) || t.includes(cand));
  } catch (e) { return true; }
};

// Words a real product's self-description uses; a bare meme lander doesn't.
const UTILITY_WORDS = /\b(protocol|infrastructure|platform|network|api|sdk|docs|documentation|whitepaper|lending|borrow|trading|exchange|payments?|compute|oracle|bridge|wallet|agent|analytics|data|index|treasury|rwa|defi|staking|yield|liquidity|governance|marketplace|identity|storage)\b/i;

const TIERS = {
  hot: { head: '🔥 Best guess', body: 'passes every safety metric with real utility signals.' },
  gem: { head: '💎 Possible gem', body: 'passes every safety metric, has a website, thinner proof — DYOR.' },
  band: { head: '🚀 Momentum', body: (c) => `entered the $${Math.round(BAND_MIN / 1000)}K–$${Math.round(BAND_MAX / 1000)}K band${hasKw(c.blob) ? ' (meme — you asked for these too)' : ''}.` },
  fresh: { head: '🌱 New utility launch', body: 'brand-new, real web presence, not a name-replica. Stats may be raw — size accordingly.' },
  watch: { head: '🔔 Watchword hit', body: (c) => `matches your watchword "${c.watchWord}". Official token may not be live yet — fakes launch first. Verify against the project's own socials before touching it.` }
};

const alertToken = async (chain, card, tier, extra = '', dest = 'quality') => {
  const url = `https://basedbot.app/token/${chain}/${card.addr}`;
  const sym = sanitizeAlertText(card.symbol, 20);
  const nm = sanitizeAlertText(card.name, 40);
  const label = nm ? `${sym} — ${nm}` : (sym || card.addr.slice(0, 10));
  const t = TIERS[tier];
  const body = typeof t.body === 'function' ? t.body(card) : t.body;
  const market = `${card.age || '?'} old · MC ${card.mc || '?'} · vol ${card.vol || '?'} · ${card.tx || '?'} tx`;
  const stats = card.stats
    ? `top10 ${card.stats.top10}% · dev ${card.stats.dev}% · snipers ${card.stats.snipers}% · bundlers ${card.stats.bundlers}% · insiders ${card.stats.insiders}% · ${card.stats.holders} holders`
    : 'stats not yet on the card';
  const buttons = [[
    { text: '📍 Track', callback_data: `trk:${chain}:${card.addr}` },
    { text: '✕ Ignore', callback_data: 'ign' }
  ]];
  const webLine = card.webLine ? `\n${card.webLine}` : '';
  const ok = await sendTelegram(
    `${t.head} on Pulse (${chain})${extra}\n${label}\n${body}${webLine}\n${market}\n${stats}\n${url}`, buttons, dest);
  if (ok) console.log(`[watcher] alerted ${tier} ${card.symbol} on ${chain}`);
  return ok;
};

// ------------------------------------------------------------- exit watch ---
// Tracked tokens leave the feed, so we read basedbot's metrics API from an
// open page's origin (anonymous session). Verified shape: POST
// /api/tokens/metrics/batch { tokens:[addr], chain:<id> } -> data[addr].
const fetchTrackedMetrics = async (chain, addrs) => {
  const page = pages.get(chain);
  if (!page) return null;
  try {
    return await page.evaluate(async ({ addrs, chainId }) => {
      // Same-origin endpoint, body key "addresses" — captured from the page's
      // own traffic; works anonymously because it rides the page session.
      const r = await fetch('/api/tokens/metrics/batch', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: addrs, chain: chainId })
      });
      if (!r.ok) return { error: r.status };
      const j = await r.json().catch(() => null);
      return { data: (j && j.data) || {} };
    }, { addrs, chainId: CHAIN_IDS[chain] || 0 });
  } catch (err) {
    console.error(`[watcher] metrics fetch failed on ${chain}:`, err.message.slice(0, 80));
    return null;
  }
};

let exitApiWarned = false;
const exitWatch = async () => {
  const tracked = loadJson(TRACKED_PATH, {});
  const now = Date.now();
  let dirty = false;
  const byChain = {};
  for (const [addr, t] of Object.entries(tracked)) {
    if (now - t.ts > TRACK_TTL_MS) {
      delete tracked[addr];
      dirty = true;
      await sendTelegram(`🏁 Auto-untracked ${addr.slice(0, 10)}… (${t.chain}) after ${Math.round(TRACK_TTL_MS / 86400000)}d.`, null, 'tracking');
      continue;
    }
    (byChain[t.chain] = byChain[t.chain] || []).push(addr);
  }
  for (const [chain, addrs] of Object.entries(byChain)) {
    const res = await fetchTrackedMetrics(chain, addrs);
    if (!res) continue;
    if (res.error) {
      if (!exitApiWarned) {
        exitApiWarned = true;
        console.error(`[watcher] metrics API returned ${res.error} — exit watch degraded`);
        await sendTelegram(`⚠️ Exit watch: basedbot's metrics API refused the anonymous request (HTTP ${res.error}). Tracking still records, but deterioration alerts are degraded until this is resolved.`, null, 'tracking');
      }
      continue;
    }
    for (const addr of addrs) {
      const m = Object.entries(res.data).find(([k]) => k.toLowerCase().startsWith(addr.toLowerCase()));
      if (!m) continue;
      const v = m[1] || {};
      const holders = Number(v.holdersCount);
      const top10 = Number(v.top10HoldersPct);
      const insiders = Number(v.insidersPct);
      const t = tracked[addr];
      if (!Number.isFinite(holders)) continue;
      if (!t.baseline) {
        t.baseline = { holders, top10, insiders, ts: now };
        t.peakHolders = holders;
        dirty = true;
        continue;
      }
      t.peakHolders = Math.max(t.peakHolders || 0, holders);
      dirty = true;
      if (now - (t.lastExitAlert || 0) < REALERT_MS) continue;
      const reasons = [];
      const dropPct = t.peakHolders > 0 ? (1 - holders / t.peakHolders) * 100 : 0;
      if (dropPct >= EXIT_HOLDER_DROP_PCT) {
        reasons.push(`holders bleeding: ${t.peakHolders} → ${holders} (−${Math.round(dropPct)}%)`);
      }
      if (Number.isFinite(top10) && Number.isFinite(t.baseline.top10) &&
        top10 - t.baseline.top10 >= EXIT_STRUCT_RISE_PTS) {
        reasons.push(`top-10 concentration rising: ${Math.round(t.baseline.top10)}% → ${Math.round(top10)}%`);
      }
      if (Number.isFinite(insiders) && Number.isFinite(t.baseline.insiders) &&
        insiders - t.baseline.insiders >= EXIT_STRUCT_RISE_PTS) {
        reasons.push(`insiders rising: ${Math.round(t.baseline.insiders)}% → ${Math.round(insiders)}%`);
      }
      if (reasons.length) {
        t.lastExitAlert = now;
        await sendTelegram(
          `⚠️ EXIT WATCH (${chain})\n${addr.slice(0, 12)}…\n${reasons.join('\n')}\nhttps://basedbot.app/token/${chain}/${addr}`, null, 'tracking');
      }
    }
  }
  if (dirty) saveJson(TRACKED_PATH, tracked);
};

// --------------------------------------------------------------- browser ----
const LAUNCH_OPTS = {
  headless: true,
  channel: 'chromium',
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
};
const CONTEXT_OPTS = {
  viewport: { width: 1600, height: 1000 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'Europe/Berlin'
};

let browser = null;
const pages = new Map();

const openChain = async (chain) => {
  const context = await browser.newContext(CONTEXT_OPTS);
  const page = await context.newPage();
  // Images must not be aborted (the app removes failed <img>, killing the
  // alt-based symbols/badges) — serve a 1x1 instead. Fonts/media abort fine.
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image') {
      return route.fulfill({ status: 200, contentType: 'image/png', body: TINY_PNG });
    }
    if (type === 'media' || type === 'font') return route.abort();
    return route.continue();
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 3 });
  await page.goto(`https://basedbot.app/pulse/${chain}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(10000);
  pages.set(chain, page);
  return page;
};

const start = async () => {
  browser = await chromium.launch(LAUNCH_OPTS);
  for (const chain of CHAINS) {
    await openChain(chain);
    console.log(`[watcher] ${chain} page open`);
  }
};

// ------------------------------------------------------------------ tick ----
let ticking = false;
const noStatsStreak = new Map();
const layoutWarnedFor = new Set();

const tick = async () => {
  if (ticking) return;
  ticking = true;
  try {
    const seen = loadJson(SEEN_PATH, {});
    const names = loadJson(NAMES_PATH, {});
    const watchwords = loadJson(WATCH_PATH, {});
    for (const chain of CHAINS) {
      let result;
      try {
        result = await pages.get(chain).evaluate(scanPage);
      } catch (err) {
        console.error(`[watcher] ${chain} page died (${err.message.slice(0, 60)}) — reopening`);
        try { await pages.get(chain)?.context().close(); } catch (e) { /* gone */ }
        await openChain(chain);
        continue;
      }
      const { cards, cardCount, withStats } = result;
      if (cardCount >= 20 && withStats === 0) {
        const streak = (noStatsStreak.get(chain) || 0) + 1;
        noStatsStreak.set(chain, streak);
        if (streak >= 20 && !layoutWarnedFor.has(chain)) {
          layoutWarnedFor.add(chain);
          await sendTelegram(`⚠️ ${chain}: cards render but stats no longer parse — basedbot may have changed their card layout. Scoring is paused on this chain until the watcher is updated.`);
        }
      } else {
        noStatsStreak.set(chain, 0);
      }

      const pending = [];
      for (const card of cards) {
        if (!card.addr) continue;
        const kw = hasKw(card.blob);
        const score = socialScore(card);
        const safe = safetyPass(card.stats);
        const replica = replicaCheck(card, names);
        const mcUsd = moneyNum(card.mc);
        const age = ageMin(card.age);

        // tier decisions (a token can earn several over its life; dedupe per tier)
        const tiers = [];
        const wnormS = normToken(card.symbol);
        const wnormN = normToken(card.name);
        for (const w of Object.keys(watchwords)) {
          if ((wnormS && wnormS.includes(w)) || (wnormN && wnormN.includes(w))) {
            card.watchWord = w.toUpperCase();
            tiers.push('watch');
            break;
          }
        }
        if (safe && !kw && score >= 2) tiers.push('hot');
        else if (safe && !kw && card.titles.includes('Website')) tiers.push('gem');
        if (mcUsd !== null && mcUsd >= BAND_MIN && mcUsd <= BAND_MAX) tiers.push('band');
        if (age !== null && age <= NEW_MAX_AGE_MIN && !kw && !replica &&
          card.titles.some((t) => UTILITY_TITLES.includes(t))) tiers.push('fresh');

        for (const tier of tiers) {
          const key = `${tier}:${card.addr}`;
          const upgraded = tier === 'hot' && !seen[key] && seen[`gem:${card.addr}`];
          if (seen[key] && Date.now() - seen[key].ts < REALERT_MS) continue;
          if (tier === 'gem' && seen[`hot:${card.addr}`]) continue; // never downgrade-noise
          pending.push({ card, tier, upgraded });
        }
      }

      // Enrich pending alerts in one metadata batch, then peek websites so the
      // alert carries the project's own self-description (or exposes a dead /
      // borrowed link). 🌱 requires a LIVE website — fake presence disqualifies.
      if (pending.length) {
        const meta = await fetchMetadata(chain, [...new Set(pending.map((x) => x.card.addr))]);
        for (const x of pending) {
          const m = meta[x.card.addr.toLowerCase()] || {};
          if (m.symbol && (!x.card.symbol || x.card.symbol === 'OG')) x.card.symbol = String(m.symbol);
          if (m.name && (!x.card.name || x.card.name === 'OG')) x.card.name = String(m.name);
          x.card.website = m.website_url || null;
        }
        for (const x of pending) {
          const key = `${x.tier}:${x.card.addr}`;
          const flags = [];
          let peek = null;
          if (x.card.website) {
            peek = await sitePeek(x.card.website);
            if (!peek.ok && x.tier === 'fresh') {
              // dead website = fake presence: no 🌱, and never re-check
              seen[key] = { ts: Date.now(), skipped: 'dead-site' };
              saveJson(SEEN_PATH, seen);
              console.log(`[watcher] skipped fresh ${x.card.symbol}: website unreachable`);
              continue;
            }
            flags.push(`🔗 ${x.card.website}`);
            flags.push(peek.ok ? `«${peek.line}»` : '⚠️ website unreachable');
            const borrowed = peek.ok && !domainMatchesToken(x.card.website, x.card.symbol, x.card.name);
            const memeSite = peek.ok && /\bmeme|knowyourmeme|coincommunities|linktr\.ee\b/i.test(peek.line + ' ' + x.card.website);
            if (borrowed) flags.push('⚠️ domain unrelated to token name (borrowed link?)');
            // 🌱 means "plausibly THEIR real site": a borrowed link or a site
            // that self-describes as meme infrastructure fails the tier.
            if (x.tier === 'fresh' && (borrowed || memeSite)) {
              seen[key] = { ts: Date.now(), skipped: borrowed ? 'borrowed-link' : 'meme-site' };
              saveJson(SEEN_PATH, seen);
              console.log(`[watcher] skipped fresh ${x.card.symbol}: ${borrowed ? 'borrowed link' : 'meme site'}`);
              continue;
            }
          } else if (x.tier === 'fresh') {
            // metadata says no website after all — card [title] was misleading
            seen[key] = { ts: Date.now(), skipped: 'no-site' };
            saveJson(SEEN_PATH, seen);
            continue;
          }
          const mcN = moneyNum(x.card.mc);
          const volN = moneyNum(x.card.vol);
          if (mcN && volN && volN > 5 * mcN) {
            flags.push(`⚠️ volume ${Math.round(volN / mcN)}x mcap — possible wash trading`);
          }
          x.card.webLine = flags.join('\n');

          // Channel routing. QUALITY: 🔥 always; 🌱 only when STRICT (the
          // site's self-description reads like a product AND the token shows
          // life); 💎 only with strong utility evidence. Everything else —
          // 🚀 momentum, basic 💎, basic 🌱 — is firehose.
          const txN = Number((x.card.tx || '').replace(/[^0-9]/g, '')) || 0;
          const freshStrict = x.tier === 'fresh' && peek && peek.ok &&
            UTILITY_WORDS.test(peek.line) && txN >= 25;
          let dest = 'firehose';
          if (x.tier === 'hot' || x.tier === 'watch') dest = 'quality';
          else if (freshStrict) dest = 'quality';
          else if (x.tier === 'gem' && socialScore(x.card) >= 4) dest = 'quality';
          const crown = freshStrict ? ' 👑' : '';
          await alertToken(chain, x.card, x.tier, (x.upgraded ? ' — upgraded from 💎' : '') + crown, dest);
          if (plugin && plugin.onSignal) { try { plugin.onSignal(chain, x.card, x.tier); } catch (e) { /* plugin errors never break alerts */ } }
          seen[key] = { ts: Date.now() };
          saveJson(SEEN_PATH, seen); // persist per-send: crash must not re-alert
        }
      }
    }
    if (plugin && plugin.onTick) { try { await plugin.onTick(); } catch (e) { console.error('[watcher] plugin.onTick failed', e.message.slice(0, 60)); } }

    // prune the replica registry
    const now = Date.now();
    let pruned = false;
    for (const [k, v] of Object.entries(names)) {
      if (now - v.ts > REPLICA_TTL_MS) { delete names[k]; pruned = true; }
    }
    saveJson(NAMES_PATH, names);
    if (pruned) console.log('[watcher] pruned replica registry');
  } catch (err) {
    console.error('[watcher] tick failed — exiting for systemd restart:', err.message);
    process.exit(1);
  } finally {
    ticking = false;
  }
};

const reloadAll = async () => {
  for (const chain of CHAINS) {
    try {
      await pages.get(chain).reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      await pages.get(chain).waitForTimeout(8000);
    } catch (err) {
      console.error(`[watcher] ${chain} reload failed:`, err.message.slice(0, 60));
    }
  }
  console.log('[watcher] pages refreshed');
};

const HEARTBEAT_MS = (config.heartbeatHours || 12) * 3600 * 1000;
let scanCount = 0;
const heartbeat = async () => {
  const seen = loadJson(SEEN_PATH, {});
  const tracked = loadJson(TRACKED_PATH, {});
  await sendTelegram(
    `💓 Watcher alive — ${scanCount} scans across ${CHAINS.join('/')}; ` +
    `${Object.keys(seen).length} alerts sent, ${Object.keys(tracked).length} token(s) tracked. ` +
    `Silence means nothing qualified.`);
  if (plugin && plugin.onHeartbeat) { try { await plugin.onHeartbeat(); } catch (e) { /* */ } }
  scanCount = 0;
};

console.log(`[watcher] v2 started — chains: ${CHAINS.join(', ')}, scan ${INTERVAL_MS / 1000}s, band $${BAND_MIN / 1000}K–$${BAND_MAX / 1000}K, fresh ≤${NEW_MAX_AGE_MIN}min, exit watch ${EXIT_CHECK_MS / 60000}min`);
await start();
try {
  const mod = await import('./plugin.mjs');
  plugin = mod.create ? mod.create({ pages, CHAINS, CHAIN_IDS, scanPage, fetchMetadata, sendTelegram, config }) : null;
  if (plugin) console.log('[watcher] local plugin loaded');
} catch (e) { /* no plugin present — normal for the public build */ }
await registerCommands(); // after plugin load, so its commands join the menu
await tick();
setInterval(() => { scanCount += 1; tick(); }, INTERVAL_MS);
setInterval(pollUpdates, 4000); // commands answer in ~4s, not every 30s scan
setInterval(reloadAll, RELOAD_MS);
setInterval(exitWatch, EXIT_CHECK_MS);
setInterval(heartbeat, HEARTBEAT_MS);
