// BasedBot 🔥 best-guess watcher — runs headless on a VPS, no wallet needed
// (Pulse is public). Scans every INTERVAL_MIN minutes, Telegrams NEW tokens
// that pass every safety metric. Mirrors the extension's v1.6 hot logic.
'use strict';

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(ROOT, 'config.json');
const SEEN_PATH = join(ROOT, 'seen.json');

const loadJson = (path, fallback) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  } catch (err) {
    console.error(`[watcher] bad JSON in ${path}:`, err.message);
    return fallback;
  }
};

const config = loadJson(CONFIG_PATH, {});
const CHAINS = config.chains || ['robinhood'];
// Pages stay open (the feed live-updates over websocket); each interval is
// just a DOM read, so short intervals are cheap.
const INTERVAL_MS = (config.intervalSec || 30) * 1000;
const RELOAD_MS = (config.reloadMin || 30) * 60 * 1000; // periodic hard refresh
const TG_TOKEN = config.tgToken || '';
let tgChatId = config.tgChatId || '';
// Re-alert when a seen token's entry is older than this (fresh runs deserve a ping).
const REALERT_MS = (config.realertHours || 24) * 3600 * 1000;

if (!TG_TOKEN) console.error('[watcher] tgToken missing in config.json — alerts will NOT send.');

// No chat id configured? Discover it: as soon as the owner messages the bot,
// getUpdates reveals the chat, and it gets persisted to config.json.
const discoverChatId = async () => {
  if (tgChatId || !TG_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates`);
    const data = await res.json();
    const msg = (data.result || []).reverse().find((u) => u.message && u.message.chat);
    if (!msg) {
      console.log('[watcher] waiting for you to message the bot (chat id unknown)...');
      return;
    }
    tgChatId = String(msg.message.chat.id);
    writeFileSync(CONFIG_PATH, JSON.stringify({ ...config, tgChatId }, null, 2));
    console.log(`[watcher] discovered chat id ${tgChatId} — alerts enabled.`);
    await sendTelegram('✅ BasedBot watcher connected. 🔥 best-guess alerts will arrive here.');
  } catch (err) {
    console.error('[watcher] chat discovery failed', err.message);
  }
};

const sendTelegram = async (text) => {
  if (!TG_TOKEN || !tgChatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChatId, text, disable_web_page_preview: true })
    });
    if (!res.ok) console.error('[watcher] telegram error', res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.error('[watcher] telegram send failed', err.message);
    return false;
  }
};

// Runs inside the page. Mirrors extension: parse per-card stats
// (holders, pro, top10, dev, snipers, bundlers, insiders, paid) + utility
// score, return tokens passing every hot gate.
const scanPage = () => {
  const SW = { GitHub: 4, MCP: 4, Docs: 3, Medium: 1, YouTube: 1, Website: 1, Discord: 1 };
  const PADS = ['Pons', 'bow.fun', 'Flap', 'Circus', 'Charms', 'Long.xyz', 'Bankr', 'Ape Store',
    'Zora', 'Clanker', 'Flaunch', 'Stroid', 'Klik', 'Trench', 'Livo',
    'Pump.fun', 'PumpFun', 'PumpSwap', 'Bags', 'Meteora DBC'];
  const KW = ['pepe', 'inu', 'doge', 'shib', 'wif', 'bonk', 'elon', 'trump', 'moon', 'wojak',
    'chad', 'frog', 'cat', 'dog', 'kitty', 'pup', 'baby', 'fart', 'butt', 'cum', 'tendies',
    'rug', 'ape', 'monke', 'gigachad', 'meme'];
  const AMB = ['cat', 'dog', 'ape', 'butt', 'baby', 'moon', 'pup', 'rug', 'cum', 'meme', 'chad'];
  const GATES = { top10: 30, dev: 2, snipers: 15, bundlers: 15, insiders: 20, holders: 100 };

  const addrOf = (h) => {
    // 0x… (case-insensitive hex) lowercased for stable keys; base58 Solana
    // addresses are case-SENSITIVE and must keep their original case (#5).
    const m = (h || '').match(/\/token\/[^/]+\/(0x[a-fA-F0-9]{6,}|[1-9A-HJ-NP-Za-km-z]{20,})/);
    if (!m) return null;
    return m[1].startsWith('0x') ? m[1].toLowerCase() : m[1];
  };
  const hasKw = (t) => KW.some((kw) => AMB.includes(kw)
    ? new RegExp(`(^|[^a-z0-9])${kw}([^a-z0-9]|$)`, 'i').test(t)
    : t.includes(kw));
  const parseStats = (card) => {
    const leaves = [...card.querySelectorAll('span,div')]
      .filter((e) => e.childElementCount === 0)
      .map((e) => e.textContent.trim()).filter(Boolean);
    const pctNum = (t) => (t.startsWith('<') ? 0.5 : Number(t.replace('%', '')));
    const countNum = (t) => {
      const m = t.match(/^([\d.]+)(K|M)?$/);
      return m ? Number(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1) : null;
    };
    const pctIdx = leaves.map((t, i) => (/^<?\d+(\.\d+)?%$/.test(t) ? i : -1)).filter((i) => i >= 0);
    if (pctIdx.length < 5) return null;
    // Layout canary (#6): refuse to score unrecognizable card shapes rather
    // than silently mislabel the positional stats.
    if (pctIdx.length > 8) return null;
    const last5 = pctIdx.slice(-5);
    const [top10, dev, snipers, bundlers, insiders] = last5.map((i) => pctNum(leaves[i]));
    if ([top10, dev, snipers, bundlers, insiders].some((v) => !(v >= 0 && v <= 100))) return null;
    const holders = countNum(leaves[last5[0] - 2] || '');
    const pro = countNum(leaves[last5[0] - 1] || '');
    if (holders === null || pro === null) return null;
    return { holders, pro, top10, dev, snipers, bundlers, insiders, paid: leaves.includes('Paid') };
  };

  const cards = [...document.querySelectorAll('a[href*="/token/"]')]
    .filter((a) => addrOf(a.getAttribute('href')));
  const hot = [];
  let withStats = 0;
  for (const c of cards) {
    const alts = [...c.querySelectorAll('img')].map((i) => (i.alt || '').trim()).filter(Boolean);
    const symbol = alts[0] || '';
    const badges = alts.slice(1);
    const titles = [...c.querySelectorAll('[title]')]
      .map((e) => (e.getAttribute('title') || '').trim()).filter(Boolean);
    const blob = (c.textContent || '').slice(0, 40).toLowerCase();
    let score = 0;
    if (badges.some((b) => PADS.includes(b))) score -= 3;
    if (badges.includes('Virtual')) score += 1;
    if (hasKw(blob)) score -= 3;
    titles.forEach((t) => { if (typeof SW[t] === 'number') score += SW[t]; });
    const s = parseStats(c);
    if (s) withStats += 1;
    if (!s || !s.paid) continue;
    if (hasKw(blob)) continue; // meme-named: never alertable, however clean
    const ratio = s.holders > 0 ? s.pro / s.holders : 0;
    const safetyPass =
      s.top10 <= GATES.top10 && s.dev <= GATES.dev &&
      s.snipers <= GATES.snipers && s.bundlers <= GATES.bundlers &&
      s.insiders <= GATES.insiders && s.holders >= GATES.holders &&
      ratio >= 0.05 && ratio <= 0.6;
    if (!safetyPass) continue;
    // 🔥 = strong utility evidence; 💎 = safe + has website but thinner proof.
    const level = score >= 2 ? 'hot' : (titles.includes('Website') ? 'gem' : null);
    if (level) {
      // Full name renders right after the symbol in the card's text leaves.
      const leaves = [...c.querySelectorAll('span,div')]
        .filter((e) => e.childElementCount === 0)
        .map((e) => e.textContent.trim()).filter(Boolean);
      const symIdx = leaves.indexOf(symbol);
      let name = symIdx >= 0 ? (leaves[symIdx + 1] || '') : '';
      if (name.startsWith('/') || name === symbol) name = '';
      hot.push({
        addr: addrOf(c.getAttribute('href')),
        symbol,
        name,
        level,
        stats: `top10 ${s.top10}% · dev ${s.dev}% · snipers ${s.snipers}% · ` +
          `insiders ${s.insiders}% · ${s.holders} holders (${Math.round(ratio * 100)}% pro)`
      });
    }
  }
  return { hot, cardCount: cards.length, withStats };
};

// Page-controlled token text must never carry URLs/handles/RTL tricks into
// the trusted alert channel (#8). Mirrors the extension's sanitizer.
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

// Full Chromium + realistic fingerprint: the headless-shell build gets stuck
// on Cloudflare's "Just a moment..." challenge; this profile passes it.
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

// Persistent browser: one page per chain stays open, the live feed streams in
// over websocket, and each tick only re-reads the DOM.
let browser = null;
const pages = new Map(); // chain -> page

const openChain = async (chain) => {
  const context = await browser.newContext(CONTEXT_OPTS);
  const page = await context.newPage();
  // We only read the DOM tree — pixels are irrelevant. Blocking images/fonts/
  // CSS and throttling the renderer cuts steady-state CPU/memory massively.
  // Images must NOT be aborted — the app removes failed <img> elements, which
  // destroys the symbol/badge alts our scoring reads. A 1x1 transparent PNG
  // keeps the DOM intact at near-zero decode cost.
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
  await page.waitForTimeout(10000); // initial feed populate + Cloudflare clearance
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

let ticking = false;
const noStatsStreak = new Map(); // chain -> consecutive ticks with 0 parsed stats
const layoutWarnedFor = new Set();
const tick = async () => {
  if (ticking) return; // never overlap
  ticking = true;
  try {
    await discoverChatId();
    const seen = loadJson(SEEN_PATH, {});
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
      const { hot, cardCount, withStats } = result;
      // Layout-drift alarm (#6): a populated feed where nothing parses means
      // basedbot changed their cards — say so once instead of going silent.
      if (cardCount >= 20 && withStats === 0) {
        const streak = (noStatsStreak.get(chain) || 0) + 1;
        noStatsStreak.set(chain, streak);
        if (streak >= 20 && !layoutWarnedFor.has(chain)) {
          layoutWarnedFor.add(chain);
          await sendTelegram(`⚠️ ${chain}: cards render but stats no longer parse — basedbot may have changed their card layout. Scoring is effectively paused on this chain until the watcher is updated.`);
        }
      } else {
        noStatsStreak.set(chain, 0);
      }
      for (const t of hot) {
        // seen entries: {ts, level}. A 💎 that later earns 🔥 re-alerts as the upgrade.
        const prior = typeof seen[t.addr] === 'number'
          ? { ts: seen[t.addr], level: 'hot' } : seen[t.addr];
        const upgraded = prior && prior.level === 'gem' && t.level === 'hot';
        if (prior && !upgraded && Date.now() - prior.ts < REALERT_MS) continue;
        const url = `https://basedbot.app/token/${chain}/${t.addr}`;
        const sym = sanitizeAlertText(t.symbol, 20);
        const nm = sanitizeAlertText(t.name, 40);
        const label = nm ? `${sym} — ${nm}` : (sym || t.addr.slice(0, 10));
        const head = t.level === 'hot'
          ? `🔥 Best guess on Pulse (${chain})${upgraded ? ' — upgraded from 💎' : ''}`
          : `💎 Possible gem on Pulse (${chain})`;
        const body = t.level === 'hot'
          ? 'passes every safety metric with real utility signals.'
          : 'passes every safety metric, has a website, thinner utility proof — DYOR.';
        const ok = await sendTelegram(`${head}\n${label}\n${body}\n${t.stats}\n${url}`);
        if (ok) console.log(`[watcher] alerted ${t.level} ${t.symbol} on ${chain}`);
        seen[t.addr] = { ts: Date.now(), level: t.level };
        // Persist immediately — a crash mid-tick must never forget a sent
        // alert, or it repeats after the systemd restart.
        writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2));
      }
    }
  } catch (err) {
    console.error('[watcher] tick failed — exiting for systemd restart:', err.message);
    process.exit(1);
  } finally {
    ticking = false;
  }
};

// Hard refresh each page periodically so a drifted/stale SPA never lies to us.
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

// Periodic liveness ping so silence is provably "no qualifying tokens",
// never "the watcher died".
const HEARTBEAT_MS = (config.heartbeatHours || 12) * 3600 * 1000;
let scanCount = 0;
const origTick = tick;
const heartbeat = async () => {
  const seen = loadJson(SEEN_PATH, {});
  await sendTelegram(
    `💓 Watcher alive — ${scanCount} scans since last heartbeat across ` +
    `${CHAINS.join('/')}; ${Object.keys(seen).length} token(s) alerted so far. ` +
    `Silence means nothing qualified.`
  );
  scanCount = 0;
};

console.log(`[watcher] started — chains: ${CHAINS.join(', ')}, scan every ${INTERVAL_MS / 1000}s, reload every ${RELOAD_MS / 60000}min, heartbeat every ${HEARTBEAT_MS / 3600000}h`);
await start();
await origTick();
setInterval(() => { scanCount += 1; origTick(); }, INTERVAL_MS);
setInterval(reloadAll, RELOAD_MS);
setInterval(heartbeat, HEARTBEAT_MS);
