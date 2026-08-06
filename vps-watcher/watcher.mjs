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
// Per-chain tier policy. Solana/BSC are added for UTILITY discovery only —
// their meme flow is the whole reason the firehose felt like noise, so the
// 'band' (momentum, memes-welcome) lane is deliberately robinhood-only.
const CHAIN_TIERS = config.chainTiers || {
  robinhood: ['hot', 'gem', 'band', 'fresh', 'watch'],
  base: ['hot', 'gem', 'band', 'fresh', 'watch'],
  ethereum: ['hot', 'gem', 'band', 'fresh', 'watch'],
  solana: ['hot', 'gem', 'fresh', 'watch'],
  bsc: ['hot', 'gem', 'fresh', 'watch']
};
// basedbot's token URLs use a different slug than its pulse path on Solana.
const LINK_SLUG = { solana: 'sol' };
const linkChain = (c) => LINK_SLUG[c] || c;

// Telegram HTML mode gives us <b>, <code>, <a> and blockquotes — but token
// names, site descriptions and community comments are all written by strangers,
// so nothing interpolated may reach the parser unescaped.
const esc = (t) => String(t ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A name that already alerted recently must not alert again under a NEW
// address: 25 different contracts called "ELE" crossed the band in 24h and
// each one fired. Address-level dedupe cannot see that; name-level can.
const NAME_DEDUPE_MS = (config.nameDedupeHours || 12) * 3600 * 1000;
// 💎/🔥 substance floors — clean stats on a 12-minute-old $2K token are not a
// gem, they are an absence of history. Learned from calling `hue` at $23K.
const GEM_MIN_AGE_MIN = config.gemMinAgeMin || 20;
const GEM_MIN_MC_USD = config.gemMinMcUsd || 40000;
const GEM_MIN_VOL_USD = config.gemMinVolUsd || 15000;
// Firehose admission: a momentum coin with no web presence still earns a slot
// if the turnover is real. Below this, with no utility signal, it is noise.
const FIREHOSE_MIN_VOL_USD = config.firehoseMinVolUsd || 75000;
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

// ---- 🪝 Hook intelligence (ETH mainnet, data: v4hooks.org public JSON) -----
// Young, named, multi-pool v4 hooks gaining traction — surfaced once each to
// the quality chat. Established launchpad template families are excluded:
// they are infrastructure, not news. Mirrors the extension's popup scorer.
const HOOKS_CHECK_MS = (config.hooksCheckHours || 6) * 3600 * 1000;
const HOOKS_FEED = config.hooksFeedUrl || 'https://v4hooks.org/data/hook_graph.json';
const HOOKS_ENABLED = config.hooksWatch !== false;
const HOOK_TEMPLATE_FAMILIES =
  /^(FeeHook|UniversalKlik|ClankerHook|LivoSwap|Sa1tHook|EthCreatorFeeHook|QuoteAssetCreatorFeeHook|V4TaxHook|ERC1967Proxy)/i;

const scoreHooks = (nodes, nowMs, maxAgeDays = 21, topN = 10) => {
  const out = [];
  for (const n of nodes || []) {
    if (!n || !n.label || HOOK_TEMPLATE_FAMILIES.test(n.label)) continue;
    const pools = Number(n.pools) || 0;
    if (pools < 2 || n.status === 'dormant') continue;
    const firstTs = Date.parse(n.first || '');
    if (!Number.isFinite(firstTs)) continue;
    const ageDays = (nowMs - firstTs) / 86400000;
    if (ageDays > maxAgeDays || ageDays < 0) continue;
    const velocity = Number(n.velocity) || 0;
    const accel = Number(n.accel) || 0;
    const verified = n.verified === 'yes' || n.verified === true;
    const score = accel * 3 + velocity * 2 + pools * 0.5 +
      (maxAgeDays - ageDays) * 0.3 + (verified ? 2 : 0);
    out.push({ address: n.id, name: n.label, pools, status: n.status || '?',
      ageDays: Math.round(ageDays * 10) / 10, verified, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, topN);
};

// ---- 🪝 On-chain hook registry (robinhood + base + ethereum) ---------------
// Chain-native and dependency-free: Uniswap v4's PoolManager emits
// Initialize(id, currency0, currency1, fee, tickSpacing, hooks, ...) on every
// new pool. Polling those logs via public RPC builds our own per-chain hook
// registry — the v4hooks.org feed above only covers named mainnet hooks.
// Topic hash verified empirically against RH chain block 25977605.
const INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
// Swap(id, sender, …) — verified empirically on RH chain. Counting swaps on
// YOUNG hooked pools is the "people are actually buying it" signal.
const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
// 🪝🌱 the SATO shape: fresh listing + bespoke hook (not a factory template,
// so few pools total) + real swap flow. Inverse of the factory detector above.
const HOOK_LAUNCH_MIN_SWAPS = config.hookLaunchMinSwaps || 40;
const HOOK_LAUNCH_MAX_AGE_H = config.hookLaunchMaxAgeH || 24;
const HOOK_BESPOKE_MAX_POOLS = config.hookBespokeMaxPools || 5;
// Honeypot guard: a pool nobody can sell out of is not "real flow".
const HOOK_MIN_SELLS = config.hookMinSells || 5;
const HOOK_MIN_SELL_SHARE = config.hookMinSellShare || 0.15;
const HOOK_MIN_DIRECTIONAL = config.hookMinDirectional || 12;  // sample floor for the ratio
const HOOK_RPCS = config.hookRpcs || {
  robinhood: { url: 'https://rpc.mainnet.chain.robinhood.com',
    pm: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    explorer: 'https://robinhoodchain.blockscout.com/address/' },
  base: { url: 'https://mainnet.base.org',
    pm: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    explorer: 'https://basescan.org/address/' },
  ethereum: { url: 'https://eth.drpc.org',
    pm: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    explorer: 'https://etherscan.io/address/' }
};
const MAJORS_PATH = join(ROOT, 'majors.json');   // established tickers elsewhere
const HOOK_REGISTRY_PATH = join(ROOT, 'hooks-registry.json');
const HOOK_SCAN_MS = (config.hookScanMin || 10) * 60 * 1000;
const HOOK_MIN_POOLS = config.hookMinPools || 3;   // alert once a hook reaches this
const HOOK_MAX_AGE_DAYS = config.hookMaxAgeDays || 14;
const ZERO_HOOK = '0x0000000000000000000000000000000000000000';

const rpcCall = async (url, method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 90)}`);
  return j.result;
};

// The tokens a hook's pools trade. Quote currencies (WETH/USDC…) appear in
// most of a hook's pools — frequency-filter them out so what remains are the
// project tokens. Names resolve through basedbot's own metadata API, and every
// resolved token links straight into basedbot's token page.
const describeHookTokens = async (chain, h) => {
  try {
    const tokens = (h.tokens || []).slice(0, 6);
    if (!tokens.length) return '';
    const counts = {};
    for (const t of tokens) counts[t] = (counts[t] || 0) + 1;
    const projects = tokens.filter((t) => h.pools < 3 || counts[t] <= Math.ceil(h.pools * 0.6));
    const pick = (projects.length ? projects : tokens).slice(0, 3);
    const meta = await fetchMetadata(chain, pick).catch(() => ({}));
    const lines = [];
    for (const a of pick) {
      const m = meta[a.toLowerCase()];
      const sym = m && (m.symbol || m.name);
      lines.push(sym
        ? `· ${String(sym).slice(0, 18)} — https://basedbot.app/token/${linkChain(chain)}/${a}`
        : `· ${a.slice(0, 10)}… — https://basedbot.app/token/${linkChain(chain)}/${a}`);
    }
    return lines.join('\n');
  } catch (e) { return ''; }
};

const onchainHooksScan = async () => {
  if (!HOOKS_ENABLED) return;
  const reg = loadJson(HOOK_REGISTRY_PATH, {});
  for (const [chain, c] of Object.entries(HOOK_RPCS)) {
    try {
      const head = parseInt(await rpcCall(c.url, 'eth_blockNumber', []), 16);
      reg[chain] = reg[chain] || {};
      const state = reg[chain] || { lastBlock: 0, hooks: {}, pools: {} };
      state.hooks = state.hooks || {};
      state.pools = state.pools || {};   // must exist even when a scan finds nothing
      // first run starts shallow; later runs resume where they left off,
      // chunked to stay inside public-RPC getLogs limits.
      let from = state.lastBlock > 0 ? state.lastBlock + 1 : Math.max(1, head - 3000);
      // Adaptive window: a fixed size fails on busy chains (robinhood blew past
      // the 10k-log ceiling, base returned "response too large"), and a failed
      // chunk silently starved the hooked-project detector. Shrink on refusal
      // and keep the smaller window for the rest of the run.
      let span = Number(config.hookChunkBlocks) || (chain === 'base' ? 400 : 1200);
      while (from <= head) {
        const to = Math.min(from + span, head);
        // one call, both event types — an OR-list in topic position 0
        let logs = null;
        for (let attempt = 0; attempt < 5 && logs === null; attempt += 1) {
          try {
            logs = await rpcCall(c.url, 'eth_getLogs', [{
              address: c.pm, topics: [[INIT_TOPIC, SWAP_TOPIC]],
              fromBlock: '0x' + from.toString(16),
              toBlock: '0x' + Math.min(from + span, head).toString(16)
            }]);
          } catch (err) {
            if (/exceeds limit|too large|response size|block range|query returned/i.test(err.message) && span > 50) {
              span = Math.max(50, Math.floor(span / 3));
            } else throw err;
          }
        }
        if (logs === null) break;   // this chain is refusing; try again next run
        for (const l of logs) {
          if (l.topics[0] === SWAP_TOPIC) {
            const p = state.pools[l.topics[1]];
            if (p) {
              p.swaps = (p.swaps || 0) + 1;
              // Swap(id, sender, amount0, amount1, sqrtPrice, liquidity, tick, fee):
              // amount0 > 0 means currency0 went IN — a buy of the token.
              // Counting direction is not a nicety. A 100%-sell-tax honeypot
              // produces a HIGH swap count precisely because every buy lands
              // and every sell reverts, so raw swap volume is the metric a
              // scam maximises. Only a pool people can actually LEAVE counts.
              try {
                const raw = BigInt('0x' + l.data.slice(2, 66));
                const a0 = raw >= (1n << 255n) ? raw - (1n << 256n) : raw;
                if (a0 > 0n) p.buys = (p.buys || 0) + 1;
                else if (a0 < 0n) p.sells = (p.sells || 0) + 1;
              } catch (e) { /* unparseable amount: counted in swaps only */ }
            }
            continue;
          }
          const hook = ('0x' + l.data.slice(2 + 2 * 64 + 24, 2 + 3 * 64)).toLowerCase();
          if (hook === ZERO_HOOK) continue;
          const cur = [l.topics[2], l.topics[3]]
            .map((t) => ('0x' + (t || '').slice(26)).toLowerCase())
            .filter((a) => a.length === 42 && !/^0x0{40}$/.test(a));
          // Never clobber an existing pool: re-scanning a block range (after a
          // restart or a failed chunk) would otherwise reset `alerted` and the
          // swap counters, and the same pool would alert again and again.
          if (!state.pools[l.topics[1]]) {
            state.pools[l.topics[1]] = { hook, tokens: cur, createdTs: Date.now(), swaps: 0, buys: 0, sells: 0 };
          }
          const h = state.hooks[hook] || { pools: 0, firstTs: Date.now(), tokens: [] };
          h.pools += 1;
          h.lastTs = Date.now();
          // Initialize topics: [sig, poolId, currency0, currency1] — the pool's
          // tokens. 0x0 is native ETH; the rest are the projects on this hook.
          h.tokens = h.tokens || [];
          for (const t of [l.topics[2], l.topics[3]]) {
            const addr = ('0x' + (t || '').slice(26)).toLowerCase();
            if (addr.length !== 42 || /^0x0{40}$/.test(addr)) continue;
            h.tokens = [addr, ...h.tokens.filter((x) => x !== addr)].slice(0, 8);
          }
          state.hooks[hook] = h;
        }
        from = Math.min(from + span, head) + 1;
      }
      state.lastBlock = head;
      // 🪝🌱 hooked-launch check: young pool + bespoke hook + real flow
      let launchAlerts = 0;
      for (const [poolId, p] of Object.entries(state.pools)) {
        const ageH = (Date.now() - p.createdTs) / 3600000;
        if (ageH > 48) { delete state.pools[poolId]; continue; }
        if (p.alerted || launchAlerts >= 2) continue;
        if (ageH > HOOK_LAUNCH_MAX_AGE_H) continue;
        if ((p.swaps || 0) < HOOK_LAUNCH_MIN_SWAPS) continue;
        // Two-way flow test: people must be getting OUT, not just in.
        // The share is taken over DIRECTIONAL swaps only. Measuring against
        // p.swaps mixes a historical total with counters that started later,
        // which branded busy healthy pools as one-way.
        const sells = p.sells || 0;
        const buys = p.buys || 0;
        const directional = buys + sells;
        const sellShare = directional ? sells / directional : 0;
        if (directional < HOOK_MIN_DIRECTIONAL) continue;   // not enough evidence yet
        if (sells < HOOK_MIN_SELLS || sellShare < HOOK_MIN_SELL_SHARE) {
          // Skip this round WITHOUT disqualifying: a legitimate launch may
          // simply not have had its first sells yet. A real honeypot never
          // develops them and ages out of the window on its own.
          if (!p.loggedOneWay) {
            p.loggedOneWay = true;
            console.log(`[watcher] hooked-launch held back ${poolId.slice(0, 12)}: ` +
              `${buys} buys / ${sells} sells (${Math.round(sellShare * 100)}% sells) — one-way flow so far`);
          }
          continue;
        }
        const hookInfo = state.hooks[p.hook];
        if (hookInfo && hookInfo.pools > HOOK_BESPOKE_MAX_POOLS) continue; // factory, not bespoke
        p.alerted = true;
        launchAlerts += 1;
        const meta = await fetchMetadata(chain, p.tokens.slice(0, 2)).catch(() => ({}));
        const named = p.tokens.slice(0, 2).map((a) => {
          const m = meta[a.toLowerCase()];
          const sym = m && (m.symbol || m.name);
          return `· ${sym ? String(sym).slice(0, 18) : a.slice(0, 10) + '…'} — https://basedbot.app/token/${linkChain(chain)}/${a}`;
        }).join('\n');
        await sendTelegram(
          `🪝 ─── HOOKED PROJECT ───\n` +
          `(${chain}) fresh pool, own mechanism, buyers present\n` +
          `${Math.round(p.swaps)} swaps (${buys} buys / ${sells} sells) in its first ${Math.round(ageH * 10) / 10}h · bespoke hook mechanism ` +
          `(${hookInfo ? hookInfo.pools : 1} pool${hookInfo && hookInfo.pools !== 1 ? 's' : ''} total)\n${named}\n` +
          `Hook contract: ${c.explorer}${p.hook}\n` +
          `Fresh + own mechanism + real flow — the shape SATO/uPEG had at hour one. Check the mechanism before the chart.`,
          null, 'quality');
        console.log(`[watcher] hooked-launch alert: ${chain} pool ${poolId.slice(0, 12)} (${p.swaps} swaps)`);
      }
      // prune hooks that aged out without ever alerting (registry stays small)
      for (const [a, h] of Object.entries(state.hooks)) {
        if (!h.alerted && Date.now() - h.firstTs > HOOK_MAX_AGE_DAYS * 86400000) delete state.hooks[a];
      }
      reg[chain] = state;   // (state is the same object when it already existed)
      // alert: young hook crossed the pool threshold (max 2 per chain per
      // scan — a first run must not flood the quality channel)
      let chainAlerts = 0;
      for (const [addr, h] of Object.entries(state.hooks)) {
        if (h.alerted || h.pools < HOOK_MIN_POOLS || chainAlerts >= 2) continue;
        chainAlerts += 1;
        const ageDays = Math.round((Date.now() - h.firstTs) / 8640000) / 10;
        h.alerted = true;
        const projectLines = await describeHookTokens(chain, h);
        await sendTelegram(
          `🪝 New hook active on ${chain} (v4 on-chain scan)\n` +
          `${addr.slice(0, 10)}… reached ${h.pools} pools within ${ageDays}d of first sighting.\n` +
          (projectLines ? `Projects on this hook:\n${projectLines}\n` : '') +
          `Hook contract: ${c.explorer}${addr}`, null, 'quality');
        console.log(`[watcher] onchain hook alert: ${chain} ${addr} (${h.pools} pools)`);
      }
    } catch (err) {
      console.error(`[watcher] onchain hook scan failed on ${chain}:`, err.message.slice(0, 90));
    }
  }
  saveJson(HOOK_REGISTRY_PATH, reg);
};

// One scan per address per 10 minutes — re-pastes and quote-replies are common.
const scanSeen = new Map();
const scanCooldown = (addr) => {
  const k = addr.toLowerCase();
  const last = scanSeen.get(k) || 0;
  if (Date.now() - last < 600000) return true;
  scanSeen.set(k, Date.now());
  if (scanSeen.size > 500) scanSeen.clear();
  return false;
};

let hooksLatest = []; // last scored list, for /hooks
const hooksWatch = async () => {
  if (!HOOKS_ENABLED) return;
  try {
    const res = await fetch(HOOKS_FEED);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const graph = await res.json();
    hooksLatest = scoreHooks(graph.nodes || [], Date.now());
    const seen = loadJson(SEEN_PATH, {});
    let sent = 0;
    for (const h of hooksLatest) {
      const key = `hook:${h.address}`;
      if (seen[key] || sent >= 3) continue; // cap per run — no first-run flood
      seen[key] = { ts: Date.now() };
      sent += 1;
      await sendTelegram(
        `🪝 New hook gaining traction (ETH mainnet, v4)
` +
        `${h.name}${h.verified ? ' ✓verified' : ''}
` +
        `${h.pools} pools · ${h.status} · ${h.ageDays}d old
` +
        `The next hook narrative usually starts as one of these. Not advice.
` +
        `https://etherscan.io/address/${h.address}`, null, 'quality');
      console.log(`[watcher] hook alert: ${h.name} (${h.pools} pools, ${h.status})`);
    }
    saveJson(SEEN_PATH, seen);
  } catch (err) {
    console.error('[watcher] hooks watch failed:', err.message.slice(0, 80));
  }
};
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
  { command: 'hooks', description: 'Young Uniswap v4 hooks gaining traction (ETH)' },
  { command: 'scoreboard', description: 'How every call actually performed (median, not highlights)' },
  { command: 'scan', description: 'Audit a contract — /scan 0x… (or just paste one)' },
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

🪝 HOOKS (any chat)
/hooks — young v4 hooks gaining traction on ETH mainnet

📊 CALLS
/scoreboard — what every call did, median included

🔎 CONTRACT SCAN
/scan 0x… — audit a token. Or just paste an address in this chat
and I will check it: holders, taxes, honeypot, rehash, verified source.
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
      // Bind commands ALWAYS fall through to their handlers below — binding a
      // chat is the one thing that must work from an unbound chat, and gating
      // it on owner-detection (from.id === tgChatId) was too fragile: if that
      // check ever misfires, you can never set the chat up. Only NON-bind
      // commands are restricted to already-bound chats.
      if (!bound && !isBindCmd) {
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
      if (cmd === '/scan') {
        // Accept the address anywhere in the message — people paste it on the
        // next line, or after an @botname mention.
        const a = (u.message.text || '').match(/0x[a-fA-F0-9]{40}/);
        if (!a) { await reply('Usage: /scan 0x… (a token contract address)'); continue; }
        try {
          const res = await withTimeout(scanAddress(a[0]), 25000);
          if (!res) { await reply(`🔎 ${a[0].slice(0, 12)}… — scan timed out, sources were slow. Try again shortly.`); continue; }
          await tg('sendMessage', {
            chat_id: u.message.chat.id, text: formatScan(res), parse_mode: 'HTML',
            disable_web_page_preview: true, reply_markup: { inline_keyboard: scanButtons(res) || [] }
          });
        } catch (e) { await reply(`Scan failed: ${String(e.message).slice(0, 120)}`); }
        continue;
      }
      if (cmd === '/scoreboard') {
        const calls = Object.values(loadJson(CALLS_PATH, {}));
        if (!calls.length) { await reply('📊 No calls recorded yet.'); continue; }
        const rets = calls.map((c) => (c.lastMc / c.calledMc - 1) * 100).sort((a, b) => a - b);
        const peaks = calls.map((c) => (c.peakMc / c.calledMc - 1) * 100);
        const med = rets[Math.floor(rets.length / 2)];
        const winners = rets.filter((r) => r > 0).length;
        const doubled = calls.filter((c) => c.hits.includes(2)).length;
        const rugged = rets.filter((r) => r <= -80).length;
        const top = [...calls].sort((a, b) => (b.peakMc / b.calledMc) - (a.peakMc / a.calledMc)).slice(0, 3);
        const f = (x) => `${x >= 0 ? '+' : ''}${Math.round(x)}%`;
        await reply(
          `📊 Call scoreboard — last ${Math.round(CALL_TTL_MS / 86400000)}d, ALL calls\n` +
          `${calls.length} called · ${doubled} hit 2X · ${rugged} down 80%+\n` +
          `MEDIAN call right now: ${f(med)} · up: ${winners}/${calls.length}\n` +
          `best peaks: ${top.map((c) => `$${c.symbol} ${(c.peakMc / c.calledMc).toFixed(1)}X`).join(' · ')}\n\n` +
          `The median is the honest number. A channel that only posts its 5X's ` +
          `is showing you the survivors — this one counts the graveyard too.`);
        continue;
      }
      if (cmd === '/hooks') {
        if (!hooksLatest.length) await hooksWatch();
        const named = hooksLatest.length
          ? `🪝 Named movers (ETH mainnet, via v4hooks.org):\n` + hooksLatest.slice(0, 5)
            .map((h) => `${h.status === 'accelerating' ? '▲' : '·'} ${h.name}${h.verified ? ' ✓' : ''} — ${h.pools} pools · ${h.status} · ${h.ageDays}d\n  etherscan.io/address/${h.address}`)
            .join('\n')
          : '🪝 No named mainnet movers right now.';
        const reg = loadJson(HOOK_REGISTRY_PATH, {});
        const lines = [];
        for (const [chain, st] of Object.entries(reg)) {
          const young = Object.entries(st.hooks || {})
            .filter(([, h]) => Date.now() - h.firstTs <= HOOK_MAX_AGE_DAYS * 86400000 && h.pools >= 2)
            .sort((a, b) => b[1].pools - a[1].pools).slice(0, 3);
          for (const [addr, h] of young) {
            const tok = (h.tokens || [])[0];
            lines.push(`· ${chain}: ${addr.slice(0, 10)}… — ${h.pools} pools, ${Math.round((Date.now() - h.firstTs) / 86400000)}d` +
              (tok ? `\n  latest token: basedbot.app/token/${linkChain(chain)}/${tok}` : ''));
          }
        }
        await reply(`${named}\n\n⛓ Young on-chain hooks (own scan — unnamed until checked):\n${lines.join('\n') || '· registry still warming up'}`);
        continue;
      }
      if (plugin && plugin.onCommand && await plugin.onCommand(cmd, args, reply)) continue;
      if (cmd === '/watchlist') {
        const words = loadJson(WATCH_PATH, {});
        await reply(`🔔 Watchwords: ${Object.keys(words).join(', ') || '(none — add with /watch TOKEN)'}`);
        continue;
      }
    }
    // Someone pasted a bare contract address in a bound chat: audit it without
    // being asked. Raw text only — never follow links, never sign anything.
    if (u.message && u.message.chat && !txt.startsWith('/')) {
      const fromChat = String(u.message.chat.id);
      const bound = [tgChatId, tgFirehoseChatId, tgTrackingChatId, tgQualityChatId]
        .some((id) => id && fromChat === String(id));
      const hit = (u.message.text || '').match(/0x[a-fA-F0-9]{40}/);
      if (bound && hit && !scanCooldown(hit[0])) {
        const reply = (text) => tg('sendMessage', {
          chat_id: u.message.chat.id, text, disable_web_page_preview: true,
          reply_to_message_id: u.message.message_id
        });
        console.log(`[watcher] auto-scan requested for ${hit[0].slice(0, 12)}…`);
        try {
          const res = await withTimeout(scanAddress(hit[0]), 25000);
          if (res) {
            await tg('sendMessage', {
              chat_id: u.message.chat.id, text: formatScan(res), parse_mode: 'HTML',
              disable_web_page_preview: true, reply_to_message_id: u.message.message_id,
              reply_markup: { inline_keyboard: scanButtons(res) || [] }
            });
          }
        } catch (e) { console.error('[watcher] auto-scan failed', e.message.slice(0, 80)); }
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

// A project whose PITCH is a hook mechanism — the SATO/uPEG shape. This is
// what's worth surfacing: not the hook contract address (there are thousands,
// mostly launchpad templates), but a token listing that says its mechanism is
// the hook. Matches the token's own name/symbol or its site's self-description.
const HOOK_NARRATIVE = /\b(uniswap\s*v4|v4\s*hook|hook[- ]?(powered|based|driven)|hooks?\b)/i;
const hookNarrative = (card, peekLine) => {
  const inName = HOOK_NARRATIVE.test(`${card.symbol || ''} ${card.name || ''}`);
  const inSite = Boolean(peekLine) && HOOK_NARRATIVE.test(peekLine);
  if (!inName && !inSite) return null;
  return inName ? 'name' : 'site';
};

// Established elsewhere? A brand-new listing reusing a top-market-cap ticker
// from Solana/BNB/etc is a rehash of someone else's project, not a launch.
// Refreshed daily from CoinGecko's free list; absence of the file just means
// the filter is inactive, never a crash.
const loadMajors = () => new Set(loadJson(MAJORS_PATH, { symbols: [] }).symbols || []);
let MAJORS = loadMajors();
const refreshMajors = async () => {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/coins/markets' +
      '?vs_currency=usd&order=market_cap_desc&per_page=250&page=1');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    const symbols = rows.map((r) => String(r.symbol || '').toLowerCase())
      .filter((x) => x.length >= 3);   // 1-2 char tickers collide with everything
    if (symbols.length > 50) {
      saveJson(MAJORS_PATH, { symbols, ts: Date.now() });
      MAJORS = new Set(symbols);
      console.log(`[watcher] majors list refreshed: ${symbols.length} tickers`);
    }
  } catch (err) {
    console.error('[watcher] majors refresh failed:', err.message.slice(0, 70));
  }
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
  gem: { head: '💎 Possible gem', body: (c) => `passes every safety metric, has a website, and has held ${c.age || 'a while'} with real turnover — thinner proof than 🔥, DYOR.` },
  band: { head: '🚀 Momentum', body: (c) => `entered the $${Math.round(BAND_MIN / 1000)}K–$${Math.round(BAND_MAX / 1000)}K band${hasKw(c.blob) ? ' (meme — you asked for these too)' : ''}.` },
  fresh: { head: '🌱 New utility launch', body: 'brand-new, real web presence, not a name-replica. Stats may be raw — size accordingly.' },
  watch: { head: '🔔 Watchword hit', body: (c) => `matches your watchword "${c.watchWord}". Official token may not be live yet — fakes launch first. Verify against the project's own socials before touching it.` }
};

const alertToken = async (chain, card, tier, extra = '', dest = 'quality') => {
  const url = `https://basedbot.app/token/${linkChain(chain)}/${card.addr}`;
  const sym = sanitizeAlertText(card.symbol, 20);
  const nm = sanitizeAlertText(card.name, 40);
  const label = nm ? `${sym} — ${nm}` : (sym || card.addr.slice(0, 10));
  const t = TIERS[tier];
  const body = typeof t.body === 'function' ? t.body(card) : t.body;
  const market = `${card.age || '?'} old · MC ${card.mc || '?'} · vol ${card.vol || '?'} · ${card.tx || '?'} tx`;
  const stats = card.stats
    ? `top10 ${card.stats.top10}% · dev ${card.stats.dev}% · snipers ${card.stats.snipers}% · bundlers ${card.stats.bundlers}% · insiders ${card.stats.insiders}% · ${card.stats.holders} holders`
    : 'stats not yet on the card';
  // Research row. GMGN has no Robinhood-chain support (verified), so it is
  // offered only where it actually resolves — a dead button is worse than none.
  const GMGN_CHAINS = { base: 'base', ethereum: 'eth', solana: 'sol', bsc: 'bsc' };
  const research = [{ text: '⚡ BasedBot', url }];
  if (GMGN_CHAINS[chain]) {
    research.push({ text: '📈 GMGN', url: `https://gmgn.ai/${GMGN_CHAINS[chain]}/token/${card.addr}` });
  }
  const row2 = [
    { text: '🔍 DexS', url: `https://dexscreener.com/search?q=${card.addr}` },
    { text: '🦎 Gecko', url: `https://www.geckoterminal.com/search?query=${card.addr}` }
  ];
  if (sym) row2.push({ text: '𝕏 Search', url: `https://x.com/search?q=%24${encodeURIComponent(sym)}` });
  const buttons = [
    research,
    row2,
    [{ text: '📍 Track', callback_data: `trk:${chain}:${card.addr}` },
      { text: '✕ Ignore', callback_data: 'ign' }]
  ];
  const webLine = card.webLine ? `\n${card.webLine}` : '';
  // Each alert family gets its own rule so they are distinguishable at a
  // glance in a busy channel — a listing, a hook project and a radar hit
  // should never look like the same message.
  const RULES = {
    hot: '🔥 ─── BEST GUESS ───',
    gem: '💎 ─── POSSIBLE GEM ───',
    band: '🚀 ─── MOMENTUM ───',
    fresh: '🌱 ─── NEW LISTING ───',
    watch: '🔔 ─── WATCHWORD HIT ───'
  };
  const rule = RULES[tier] || t.head;
  const ok = await sendTelegram(
    `${rule}\n${label}   (${chain})${extra}\n${body}${webLine}\n${market}\n${stats}\n${url}`, buttons, dest);
  if (ok) {
    console.log(`[watcher] alerted ${tier} ${card.symbol} on ${chain}`);
    recordCall(chain, card, tier);
  }
  return ok;
};

// -------------------------------------------------------- alpha radar ------
// purealpha.app publishes a public feed of newly-surfaced X accounts and
// projects. The signal we care about is not the account existing — it is
// follower velocity since discovery (one row went 13 → 14,073) plus whatever
// the community has written under it.
const ALPHA_PATH = join(ROOT, 'alpha-seen.json');
const ALPHA_FEED = config.alphaFeedUrl || 'https://purealpha.app/api/feed?feed=new';
const ALPHA_CHECK_MS = (config.alphaCheckMin || 15) * 60 * 1000;
const ALPHA_ENABLED = config.alphaWatch !== false;
const ALPHA_MIN_FOL = config.alphaMinFollowers || 500;
const ALPHA_MAX_PER_RUN = config.alphaMaxPerRun || 3;

const alphaWatch = async () => {
  if (!ALPHA_ENABLED) return;
  try {
    const r = await fetch(ALPHA_FEED, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const rows = j.previewRows || j.rows || [];
    const seen = loadJson(ALPHA_PATH, {});
    let sent = 0;
    for (const row of rows) {
      const handle = row.handle;
      if (!handle || seen[handle.toLowerCase()]) continue;
      // Projects only: a person's account is not something you can act on.
      if (row.kind !== 'project') continue;
      const fol = Number(row.fol) || 0;
      if (fol < ALPHA_MIN_FOL) continue;               // too small to mean anything yet
      seen[handle.toLowerCase()] = { ts: Date.now(), fol };
      if (sent >= ALPHA_MAX_PER_RUN) continue;          // marked seen, just not shouted
      sent += 1;

      const entryFol = Number((row.entry || {}).fol);
      const bios = [...new Set(row.bios || [])].slice(0, 3).join(' · ');
      const growthTree = Number.isFinite(entryFol) && entryFol > 0 && fol > entryFol
        ? `📈 <b>${fol.toLocaleString()}</b> followers\n` +
          `   ├ first seen at <b>${entryFol.toLocaleString()}</b>\n` +
          `   └ <b>${Math.round(fol / entryFol).toLocaleString()}×</b> since we spotted it`
        : `📈 <b>${fol.toLocaleString()}</b> followers`;
      const said = (row.thread || []).filter((t) => t && t.body && !t.deleted).slice(0, 3)
        .map((t) => `“${esc(String(t.body).replace(/\s+/g, ' ').slice(0, 180))}”\n— @${esc(t.xUsername || t.author)}`);

      const html = [
        '🐦 <b>NEW PROJECT ON THE RADAR</b>',
        `<b>${esc(row.name || handle)}</b>  ·  <a href="https://x.com/${encodeURIComponent(handle)}">@${esc(handle)}</a>`,
        row.summary ? `\n<blockquote>${esc(String(row.summary).slice(0, 220))}</blockquote>` : '',
        `\n${growthTree}`,
        bios ? `🏷 <i>${esc(bios)}</i>` : '',
        said.length
          ? `\n💬 <b>what people are saying</b>\n<blockquote expandable>${said.join('\n\n')}</blockquote>`
          : '',
        `\n<i>Surfaced by purealpha · an account is not a token. Find what they ship before you buy anything.</i>`
      ].filter(Boolean).join('\n');

      await tg('sendMessage', {
        chat_id: tgFirehoseChatId || tgChatId, text: html, parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[
          { text: '𝕏 Open profile', url: `https://x.com/${handle}` },
          { text: '🔎 Their posts', url: `https://x.com/search?q=from%3A${encodeURIComponent(handle)}` }
        ]] }
      });
      console.log(`[watcher] alpha radar: @${handle} (${fol} followers, ${row.kind})`);
    }
    // keep the seen-map from growing without bound
    const cutoff = Date.now() - 30 * 86400000;
    for (const [k, v] of Object.entries(seen)) if (v.ts < cutoff) delete seen[k];
    saveJson(ALPHA_PATH, seen);
  } catch (err) {
    console.error('[watcher] alpha radar failed:', String(err.message).slice(0, 80));
  }
};

// ------------------------------------------------------ contract scanner ----
// Anyone in a bound chat can paste a contract address and get an audit back.
// Read-only: chain detection by bytecode, basedbot's own metrics, GoPlus token
// security, and our own rehash/meme rules. Never signs anything.
const GOPLUS_CHAIN = { robinhood: '4663', base: '8453', ethereum: '1', bsc: '56', solana: 'solana' };

const withTimeout = (p, ms, fallback = null) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]).catch(() => fallback);

// DexScreener is the backbone: one keyless call returns the chain, symbol,
// liquidity, 24h volume, the BUY/SELL split, socials and the pair's age — with
// no browser involved, which matters because the watcher's pages recycle.
const dexScreener = async (addr) => {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
  if (!r.ok) return null;
  const j = await r.json();
  const pairs = (j && j.pairs) || [];
  if (!pairs.length) return null;
  return pairs.sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0))[0];
};

const goPlus = async (chainId, addr) => {
  const r = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${addr}`);
  if (!r.ok) return null;
  const j = await r.json();
  return Object.values((j && j.result) || {})[0] || null;
};

const scanAddress = async (addr) => {
  const out = { addr, flags: [], good: [], notes: [] };
  const DEX_CHAIN_ID = { robinhood: '4663', base: '8453', ethereum: '1', bsc: '56', solana: 'solana' };

  const pair = await withTimeout(dexScreener(addr), 9000);
  if (pair) {
    out.chain = pair.chainId;
    out.symbol = (pair.baseToken || {}).symbol || '';
    out.name = (pair.baseToken || {}).name || '';
    out.liq = ((pair.liquidity || {}).usd) || 0;
    out.vol24 = ((pair.volume || {}).h24) || 0;
    out.fdv = pair.fdv || 0;
    out.mc = pair.marketCap || pair.fdv || 0;
    out.price = pair.priceUsd;
    out.dex = pair.dexId;
    out.quote = (pair.quoteToken || {}).symbol || '';
    const ch = pair.priceChange || {};
    out.change = { m5: ch.m5, h1: ch.h1, h6: ch.h6, h24: ch.h24 };
    out.change24 = ch.h24;
    const vol = pair.volume || {};
    out.vol = { m5: vol.m5, h1: vol.h1, h24: vol.h24 };
    const tx = (pair.txns || {}).h24 || {};
    out.buys = tx.buys || 0;
    out.sells = tx.sells || 0;
    out.txWindows = pair.txns || {};
    out.ageH = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3600000 : null;
    const info = pair.info || {};
    out.websites = (info.websites || []).map((w) => w.url).filter(Boolean);
    out.socials = (info.socials || []).map((x) => `${x.type}: ${x.url}`);
  }

  // Chain fallback: no DexScreener pair means no market we can read, but the
  // address may still be a contract — say so rather than guessing a chain.
  if (!out.chain) {
    const present = [];
    for (const [chain, c] of Object.entries(HOOK_RPCS)) {
      const code = await withTimeout(rpcCall(c.url, 'eth_getCode', [addr, 'latest']), 4000);
      if (code && (code.length - 2) / 2 > 0) present.push(chain);
    }
    if (!present.length) { out.flags.push('no contract code found on any chain we watch'); return out; }
    out.chain = present[0];
    out.notes.push(`contract exists on ${present.join(', ')} but no tradeable pair was found`);
  }

  // Everything below runs in parallel and is allowed to fail: a scan that
  // cannot answer is still better than a scan that never replies.
  const gpId = DEX_CHAIN_ID[out.chain];
  const [gp, metrics] = await Promise.all([
    gpId ? withTimeout(goPlus(gpId, addr), 9000) : null,
    withTimeout(fetchTrackedMetrics(out.chain, [addr]), 7000)
  ]);

  if (gp) {
    const pct = (x) => (x === undefined || x === null || x === '' ? null : Number(x) * 100);
    const sell = pct(gp.sell_tax), buy = pct(gp.buy_tax);
    out.honeypot = gp.is_honeypot === '1' ? true : (gp.is_honeypot === '0' ? false : undefined);
    if (buy !== null) out.taxB = Math.round(buy);
    if (sell !== null) out.taxS = Math.round(sell);
    if (gp.is_honeypot === '1') out.flags.push('GoPlus flags this as a HONEYPOT');
    if (sell !== null && sell >= 20) out.flags.push(`sell tax ${sell.toFixed(0)}%`);
    if (buy !== null && buy >= 20) out.flags.push(`buy tax ${buy.toFixed(0)}%`);
    if (gp.cannot_sell_all === '1') out.flags.push('cannot sell entire balance');
    if (gp.is_blacklisted === '1') out.flags.push('has a blacklist function');
    if (gp.is_mintable === '1') out.flags.push('supply is mintable');
    if (gp.transfer_pausable === '1') out.flags.push('transfers can be paused');
    if (gp.is_open_source === '0') out.flags.push('source NOT verified');
    else if (gp.is_open_source === '1') out.good.push('source verified');
    if (gp.owner_address && /^0x0{40}$/.test(gp.owner_address)) out.good.push('ownership renounced');
    if (gp.holder_count) out.holders = Number(gp.holder_count);
  }

  // basedbot's own holder structure — the only source for bundlers/snipers.
  if (metrics && metrics.data) {
    const m = Object.entries(metrics.data).find(([k]) => k.toLowerCase().startsWith(addr.toLowerCase()));
    if (m) {
      const v = m[1] || {};
      out.stats = {
        holders: Number(v.holdersCount), top10: Number(v.top10HoldersPct),
        insiders: Number(v.insidersPct), snipers: Number(v.snipersPct),
        bundlers: Number(v.bundlersPct), dev: Number(v.devHoldingsPct)
      };
      const st = out.stats;
      if (Number.isFinite(st.bundlers) && st.bundlers > 20) out.flags.push(`bundlers hold ${Math.round(st.bundlers)}%`);
      if (Number.isFinite(st.snipers) && st.snipers > 30) out.flags.push(`snipers hold ${Math.round(st.snipers)}%`);
      if (Number.isFinite(st.top10) && st.top10 > 50) out.flags.push(`top-10 hold ${Math.round(st.top10)}%`);
      if (Number.isFinite(st.dev) && st.dev > 20) out.flags.push(`dev holds ${Math.round(st.dev)}%`);
      if (Number.isFinite(st.top10) && st.top10 <= 30) out.good.push(`top-10 only ${Math.round(st.top10)}%`);
      if (Number.isFinite(st.bundlers) && st.bundlers === 0) out.good.push('no bundlers');
    }
  } else {
    out.notes.push('holder structure (bundlers/snipers) unavailable right now');
  }

  // Name: is it unique, a rehash of an established ticker, or a replica of
  // something we alerted in the last week?
  const sym = String(out.symbol || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const nam = String(out.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if ((sym && MAJORS.has(sym)) || (nam && MAJORS.has(nam))) {
    out.flags.push(`name reuses an established ticker (${out.symbol}) — rehash pattern`);
  } else if (sym) out.good.push('name not a known-ticker rehash');
  if (hasKw(`${sym} ${nam}`)) out.flags.push('meme-keyword name');
  try {
    const names = loadJson(NAMES_PATH, {});
    const prior = names[sym] || names[nam];
    if (prior && prior.addr && prior.addr.toLowerCase() !== addr.toLowerCase()) {
      out.flags.push('a DIFFERENT contract used this name recently — replica risk');
    }
  } catch (e) { /* registry optional */ }

  // Web presence, and whether the site is actually alive.
  if (out.websites && out.websites.length) {
    const peek = await withTimeout(sitePeek(out.websites[0]), 7000);
    if (peek && peek.ok) {
      out.good.push('website reachable');
      if (peek.line) out.siteTitle = String(peek.line).slice(0, 100);
    } else out.flags.push('website listed but unreachable');
  } else if (!out.socials || !out.socials.length) {
    out.flags.push('no website and no socials listed');
  }

  // Two-way flow, from DexScreener's own 24h split.
  if (out.buys + out.sells >= 10) {
    const sellShare = out.sells / (out.buys + out.sells);
    if (sellShare < 0.1) out.flags.push(`one-way flow: ${out.buys} buys vs ${out.sells} sells (people are not getting out)`);
    else out.good.push(`two-way flow (${out.buys} buys / ${out.sells} sells)`);
  }
  if (out.liq !== undefined && out.liq < 5000) out.flags.push(`thin liquidity $${Math.round(out.liq).toLocaleString()}`);
  return out;
};

const scanButtons = (r) => {
  if (!r.chain) return null;
  const GMGN = { base: 'base', ethereum: 'eth', solana: 'sol', bsc: 'bsc' };
  const row1 = [{ text: '⚡ BasedBot', url: `https://basedbot.app/token/${linkChain(r.chain)}/${r.addr}` }];
  if (GMGN[r.chain]) row1.push({ text: '📈 GMGN', url: `https://gmgn.ai/${GMGN[r.chain]}/token/${r.addr}` });
  const row2 = [
    { text: '🔍 DexS', url: `https://dexscreener.com/search?q=${r.addr}` },
    { text: '🦎 Gecko', url: `https://www.geckoterminal.com/search?query=${r.addr}` }
  ];
  if (r.symbol) row2.push({ text: '𝕏 Search', url: `https://x.com/search?q=%24${encodeURIComponent(r.symbol)}` });
  return [row1, row2];
};

const formatScan = (r) => {
  if (!r.chain) {
    return `🔎 <b>CONTRACT SCAN</b>\n<code>${esc(r.addr)}</code>\n\n` +
      `No contract and no market found on the chains we watch.\n` +
      `<i>Likely a wallet, a chain we do not cover, or a mistyped address.</i>`;
  }
  const money = (n) => {
    if (!Number.isFinite(n) || n === 0) return '—';
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(2)}`;
  };
  const pc = (x) => {
    if (!Number.isFinite(x)) return '—';
    return `${x > 0 ? '+' : ''}${x}%`;
  };
  const age = r.ageH === null || r.ageH === undefined ? '—'
    : r.ageH < 24 ? `${Math.round(r.ageH)}h` : `${Math.round(r.ageH / 24)}d`;

  const severe = r.flags.some((f) => /HONEYPOT|cannot sell|sell tax|one-way/i.test(f));
  const verdict = severe ? '⛔ <b>DO NOT TOUCH</b>'
    : r.flags.length >= 3 ? '🔴 <b>HIGH RISK</b>'
      : r.flags.length ? '🟠 <b>CAUTION</b>'
        : '🟢 <b>NOTHING ALARMING</b>';

  const L = [];
  L.push('🔎 <b>CONTRACT SCAN</b>');
  L.push(`<b>${esc(r.symbol || r.addr.slice(0, 10))}</b>${r.name && r.name !== r.symbol ? ` · ${esc(r.name)}` : ''}`);
  L.push(`${verdict}   <i>${esc(r.chain)}${r.dex ? ' · ' + esc(r.dex) : ''} · ${age} old</i>`);

  // market block — liquidity as a share of MC is the fastest read on float
  const liqPct = r.mc > 0 && r.liq ? ` <i>(${Math.round((r.liq / r.mc) * 100)}% of MC)</i>` : '';
  const market = [
    `├ MC     <b>${money(r.mc)}</b>`,
    `├ Liq    <b>${money(r.liq)}</b>${liqPct}`,
    r.price ? `├ Price  <code>$${Number(r.price) < 0.01 ? Number(r.price).toFixed(10).replace(/0+$/, '') : Number(r.price).toFixed(6)}</code>` : null,
    (r.taxB !== undefined || r.taxS !== undefined)
      ? `└ Tax    B <b>${r.taxB ?? '?'}%</b> · S <b>${r.taxS ?? '?'}%</b>${r.honeypot === false ? '  ✅' : ''}`
      : `└ Tax    <i>unknown</i>`
  ].filter(Boolean).join('\n');
  L.push(`\n💰 <b>MARKET</b>\n<blockquote>${market}</blockquote>`);

  // movement
  const c = r.change || {};
  const total = (r.buys || 0) + (r.sells || 0);
  const sellPct = total ? Math.round((r.sells / total) * 100) : null;
  const move = [
    `├ 5m ${pc(c.m5)}  ·  1h ${pc(c.h1)}  ·  6h ${pc(c.h6)}  ·  24h ${pc(c.h24)}`,
    `├ vol 24h  <b>${money((r.vol || {}).h24)}</b>`,
    `└ trades   <b>${r.buys}</b> buys · <b>${r.sells}</b> sells${sellPct !== null ? ` <i>(${sellPct}% sells)</i>` : ''}`
  ].join('\n');
  L.push(`\n📈 <b>MOVEMENT</b>\n<blockquote>${move}</blockquote>`);

  // holders
  const st = r.stats;
  const holders = (st && Number.isFinite(st.holders)) ? st.holders : r.holders;
  if (st || holders) {
    const rows = [
      `├ holders  <b>${holders ? holders.toLocaleString() : '—'}</b>`,
      st ? `├ top 10   <b>${Math.round(st.top10)}%</b>  ·  dev <b>${Math.round(st.dev || 0)}%</b>` : null,
      st ? `└ snipers  <b>${Math.round(st.snipers || 0)}%</b>  ·  bundlers <b>${Math.round(st.bundlers || 0)}%</b>  ·  insiders <b>${Math.round(st.insiders || 0)}%</b>` : null
    ].filter(Boolean).join('\n');
    L.push(`\n👤 <b>HOLDERS</b>\n<blockquote>${rows}</blockquote>`);
  }

  // presence
  const pres = [];
  if (r.websites && r.websites.length) pres.push(`├ <a href="${esc(r.websites[0])}">${esc(r.websites[0].replace(/^https?:\/\//, '').slice(0, 46))}</a>`);
  if (r.siteTitle) pres.push(`├ <i>“${esc(r.siteTitle)}”</i>`);
  for (const soc of (r.socials || []).slice(0, 2)) {
    const url = soc.split(': ').slice(1).join(': ');
    pres.push(`├ <a href="${esc(url)}">${esc(url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 46))}</a>`);
  }
  if (pres.length) {
    pres[pres.length - 1] = pres[pres.length - 1].replace('├', '└');
    L.push(`\n🌐 <b>PRESENCE</b>\n<blockquote>${pres.join('\n')}</blockquote>`);
  }

  if (r.flags.length) {
    L.push(`\n⚠️ <b>FLAGS</b>\n<blockquote${r.flags.length > 3 ? ' expandable' : ''}>${r.flags.map((f) => `• ${esc(f)}`).join('\n')}</blockquote>`);
  }
  if (r.good.length) L.push(`\n✅ <i>${esc(r.good.join(' · '))}</i>`);
  if (r.notes.length) L.push(`ℹ️ <i>${esc(r.notes.join(' · '))}</i>`);

  L.push(`\n<code>${esc(r.addr)}</code>`);
  L.push(`<i>DYOR · read-only: chain · DexScreener · GoPlus · basedbot. No flags ≠ safe.</i>`);
  return L.join('\n');
};

// -------------------------------------------------- call performance --------
// Every alert is recorded with the market cap it was called at, then followed
// so the channel can show what a call actually did. The milestone posts are the
// fun part; the honest part is that losers are recorded too and /scoreboard
// reports the MEDIAN outcome, not a highlight reel of the winners.
const CALLS_PATH = join(ROOT, 'calls.json');
const CALL_TTL_MS = (config.callTtlDays || 7) * 24 * 3600 * 1000;
const MILESTONES = config.callMilestones || [1.5, 2, 3, 5, 10];

const recordCall = (chain, card, tier) => {
  try {
    const mc = moneyNum(card.mc);
    if (!(mc > 0)) return;   // no entry price = nothing to measure against
    const calls = loadJson(CALLS_PATH, {});
    if (calls[card.addr]) return;             // first call is the reference
    calls[card.addr] = {
      chain, tier, symbol: sanitizeAlertText(card.symbol, 20) || card.addr.slice(0, 8),
      calledMc: mc, calledTs: Date.now(), peakMc: mc, lastMc: mc, hits: []
    };
    saveJson(CALLS_PATH, calls);
  } catch (err) { /* never let bookkeeping break an alert */ }
};

const fmtMc = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000)}k`);

// Marks every open call against live feed prices, posts milestone hits.
const callWatch = async (marksByChain) => {
  const calls = loadJson(CALLS_PATH, {});
  if (!Object.keys(calls).length) return;
  const now = Date.now();
  let dirty = false;
  for (const [addr, c] of Object.entries(calls)) {
    if (now - c.calledTs > CALL_TTL_MS) { delete calls[addr]; dirty = true; continue; }
    const mc = (marksByChain[c.chain] || {})[addr];
    if (!(mc > 0)) continue;
    c.lastMc = mc;
    if (mc > c.peakMc) { c.peakMc = mc; dirty = true; }
    const mult = mc / c.calledMc;
    for (const m of MILESTONES) {
      if (mult >= m && !c.hits.includes(m)) {
        c.hits.push(m);
        dirty = true;
        const icon = m >= 5 ? '🔥' : '⚡';
        await sendTelegram(
          `${icon} ─── CALL UPDATE ───\n$${c.symbol} hit ${m}X\n` +
          `called ${fmtMc(c.calledMc)} → ${fmtMc(mc)}\n` +
          `peak since the call · dyor\n` +
          `https://basedbot.app/token/${linkChain(c.chain)}/${addr}`, null, 'quality');
        console.log(`[watcher] call milestone: ${c.symbol} ${m}X (${Math.round(c.calledMc / 1000)}k→${Math.round(mc / 1000)}k)`);
      }
    }
  }
  if (dirty) saveJson(CALLS_PATH, calls);
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
          `⚠️ EXIT WATCH (${chain})\n${addr.slice(0, 12)}…\n${reasons.join('\n')}\nhttps://basedbot.app/token/${linkChain(chain)}/${addr}`, null, 'tracking');
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
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: config.cpuThrottle || 2 });
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
let scanCursor = 0;
const SCAN_PER_TICK = config.scanChainsPerTick || 2;
const noStatsStreak = new Map();
const layoutWarnedFor = new Set();

const tick = async () => {
  if (ticking) return;
  ticking = true;
  try {
    const seen = loadJson(SEEN_PATH, {});
    const names = loadJson(NAMES_PATH, {});
    const watchwords = loadJson(WATCH_PATH, {});
    // Round-robin the chain list. Scanning all five every tick starved the
    // throttled browser pages: a scan landed mid-render and saw 30 cards with
    // zero stats, so nothing could ever clear a safety gate. Per-tick work is
    // now constant and each chain still comes round every few ticks.
    const marksByChain = {};
    const slice = CHAINS.length <= SCAN_PER_TICK ? CHAINS
      : Array.from({ length: SCAN_PER_TICK }, (_, i) => CHAINS[(scanCursor + i) % CHAINS.length]);
    scanCursor = (scanCursor + slice.length) % CHAINS.length;
    for (const chain of slice) {
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
        // 💎 needs SUBSTANCE, not just clean stats. A token minutes old has a
        // flat holder distribution because nothing has had time to concentrate
        // — passing the safety gates then means almost nothing. The same trap
        // as counting swaps on a honeypot: a metric that is free to satisfy is
        // not evidence. So a gem must also have survived a while, carry real
        // liquidity, and show actual turnover.
        const volN = moneyNum(card.vol);
        const substantial = age !== null && age >= GEM_MIN_AGE_MIN &&
          mcUsd !== null && mcUsd >= GEM_MIN_MC_USD &&
          volN !== null && volN >= GEM_MIN_VOL_USD;
        if (safe && !kw && score >= 2 && substantial) tiers.push('hot');
        else if (safe && !kw && card.titles.includes('Website') && substantial) tiers.push('gem');
        else if (safe && !kw && card.titles.includes('Website') && !substantial &&
          age !== null && age <= NEW_MAX_AGE_MIN) {
          // clean but too young to judge — that is the 🌱 story, not 💎
          tiers.push('fresh');
        }
        if (mcUsd !== null && mcUsd >= BAND_MIN && mcUsd <= BAND_MAX) tiers.push('band');
        if (age !== null && age <= NEW_MAX_AGE_MIN && !kw && !replica &&
          card.titles.some((t) => UTILITY_TITLES.includes(t))) tiers.push('fresh');

        // Rehash guard: a new listing reusing an established ticker from
        // another chain is someone else's project relabelled.
        const sym = normToken(card.symbol);
        const nam = normToken(card.name);
        const rehash = (sym && MAJORS.has(sym)) || (nam && MAJORS.has(nam));
        if (rehash) {
          console.log(`[watcher] skipped ${card.symbol}: rehash of an established ticker`);
          continue;
        }
        const allowed = CHAIN_TIERS[chain] || CHAIN_TIERS.robinhood;
        for (const tier of tiers) {
          if (!allowed.includes(tier)) continue;   // e.g. no meme 'band' lane on solana/bsc
          const key = `${tier}:${card.addr}`;
          const upgraded = tier === 'hot' && !seen[key] && seen[`gem:${card.addr}`];
          if (seen[key] && Date.now() - seen[key].ts < REALERT_MS) continue;
          if (tier === 'gem' && seen[`hot:${card.addr}`]) continue; // never downgrade-noise
          // Name-level dedupe: the same ticker under a fresh address is the
          // same message to a reader. Watchwords are exempt (that IS the ask).
          const nkey = sym || nam;
          if (tier !== 'watch' && nkey && nkey.length >= 3) {
            const prior = seen[`name:${nkey}`];
            if (prior && prior.addr !== card.addr && Date.now() - prior.ts < NAME_DEDUPE_MS) {
              console.log(`[watcher] deduped ${tier} ${card.symbol}: same name alerted ${Math.round((Date.now() - prior.ts) / 60000)}min ago`);
              continue;
            }
          }
          pending.push({ card, tier, upgraded, nkey });
        }
      }

      marksByChain[chain] = marksByChain[chain] || {};
      for (const c of result.cards) {
        const m = moneyNum(c.mc);
        if (c.addr && m > 0) marksByChain[chain][c.addr] = m;
      }
      // A render-incomplete scan (cards present, zero stats parsed) must not
      // be treated as truth: every safety gate would silently read "unknown".
      if (result.cards.length && !result.withStats) {
        // One cheap retry beats discarding the cycle: the page is usually a
        // couple of seconds from having its stats painted.
        await new Promise((r) => setTimeout(r, 6000));
        try {
          result = await pages.get(chain).evaluate(scanPage);
        } catch (e) { /* keep the first result; the guard below still applies */ }
        if (result.cards.length && !result.withStats) {
          console.log(`[watcher] ${chain}: still mid-render after retry (${result.cards.length} cards) — skipping`);
          continue;
        }
      }
      if (process.env.BBD_DEBUG_TIERS) {
        console.log(`[debug] ${chain}: cards=${result.cards.length} withStats=${result.withStats} pending=${pending.length}`);
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
          const stampName = () => {
            if (x.tier !== 'watch' && x.nkey && x.nkey.length >= 3) {
              seen[`name:${x.nkey}`] = { addr: x.card.addr, ts: Date.now() };
            }
          };
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
          // A listing whose own pitch is a hook mechanism (SATO/uPEG shape) is
          // the hook signal worth a human's attention — not a contract address.
          const hookWhy = hookNarrative(x.card, peek && peek.ok ? peek.line : '');
          if (hookWhy) {
            flags.push(hookWhy === 'name'
              ? '🪝 hook mechanism in the token name'
              : '🪝 the project describes a hook mechanism');
          }
          // Firehose is the FIRST filter, not the overflow bin: utility
          // evidence, possible gems, or genuine volume — from any chain we
          // track. A momentum crossing with neither a web presence nor real
          // turnover is exactly the meme noise that made the channel 80% junk,
          // so it is dropped rather than routed.
          const hasUtility = x.card.titles.some((t) => UTILITY_TITLES.includes(t));
          const volUsd = moneyNum(x.card.vol) || 0;
          const bigVolume = volUsd >= FIREHOSE_MIN_VOL_USD;
          if (x.tier === 'band' && !hasUtility && !bigVolume && !hookWhy) {
            seen[key] = { ts: Date.now(), skipped: 'no-utility-no-volume' };
            saveJson(SEEN_PATH, seen);
            console.log(`[watcher] dropped band ${x.card.symbol}: no utility, vol $${Math.round(volUsd / 1000)}K`);
            continue;
          }
          let dest = 'firehose';
          if (x.tier === 'hot' || x.tier === 'watch') dest = 'quality';
          else if (freshStrict) dest = 'quality';
          else if (hookWhy) dest = 'quality';   // hook-narrative listings are rare; promote
          else if (x.tier === 'gem' && socialScore(x.card) >= 4) dest = 'quality';
          const crown = (freshStrict ? ' 👑' : '') + (hookWhy ? ' 🪝' : '');
          await alertToken(chain, x.card, x.tier, (x.upgraded ? ' — upgraded from 💎' : '') + crown, dest);
          if (plugin && plugin.onSignal) { try { plugin.onSignal(chain, x.card, x.tier); } catch (e) { /* plugin errors never break alerts */ } }
          stampName();
          seen[key] = { ts: Date.now() };
          saveJson(SEEN_PATH, seen); // persist per-send: crash must not re-alert
        }
      }
    }
    try { await callWatch(marksByChain); } catch (e) { console.error('[watcher] callWatch failed', e.message.slice(0, 70)); }
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
// Timers are registered BEFORE the first scan. Awaiting that scan used to
// block every setInterval below it, and once the chain list grew to five a
// single tick could outlast them all — commands, majors refresh and the hook
// scans simply never got scheduled. The first tick needs nothing from them.
setInterval(() => { scanCount += 1; tick(); }, INTERVAL_MS);
setInterval(pollUpdates, 4000); // commands answer in ~4s, not every 30s scan
setInterval(reloadAll, RELOAD_MS);
setInterval(exitWatch, EXIT_CHECK_MS);
setTimeout(refreshMajors, 20 * 1000);
setInterval(refreshMajors, 24 * 3600 * 1000);
if (ALPHA_ENABLED) { setTimeout(alphaWatch, 120 * 1000); setInterval(alphaWatch, ALPHA_CHECK_MS); }
if (HOOKS_ENABLED) {
  setTimeout(hooksWatch, 90 * 1000);
  setInterval(hooksWatch, HOOKS_CHECK_MS);
  setTimeout(onchainHooksScan, 150 * 1000);
  setInterval(onchainHooksScan, HOOK_SCAN_MS);
}
setInterval(heartbeat, HEARTBEAT_MS);
tick();   // kick off the first scan without blocking the schedulers above
