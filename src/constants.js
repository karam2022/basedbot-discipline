// Shared constants for all content scripts (loaded first, shared scope).
'use strict';

const BBD = {};

BBD.DEFAULT_SETTINGS = Object.freeze({
  filterEnabled: true,
  reminderEnabled: true,
  notifyEnabled: false,
  thresholdPct: 20,
  snoozeMin: 15,
  refireStepPct: 10,
  // Stop-loss side of the discipline banner: nag on positions down past
  // stopLossPct so losers get cut, not just winners taken.
  stopLossEnabled: true,
  stopLossPct: 25,
  // Warn when an open winner falls this many percentage points from its
  // observed peak. This turns the journal's peak into an actionable trailing
  // discipline rule without executing trades.
  peakGivebackEnabled: true,
  peakGivebackPct: 15,
  // Trade journal: log every position's entry safety snapshot, peak, and last
  // fresh exit estimate so the popup can show behavior metrics honestly.
  journalEnabled: true,
  // Anti-FOMO guards (driven by the journal): a daily losing-trade limit that
  // shows a "step away" overlay, and a revenge-trade warning when you reopen a
  // token you just closed at a loss.
  fomoGuardEnabled: true,
  dailyLossLimit: 3,
  revengeWindowMin: 60,
  revengeToastSec: 10,
  // A close is only classified as win/loss when the last PnL sample was fresh.
  // Older samples are kept as estimates, but never drive revenge/loss guards.
  exitSampleMaxAgeSec: 60,
  // Dump alerts: watch the trade feed of held positions and ping when the dev
  // sells, or a single sell exceeds whaleSellUsd. Only recent trades count.
  dumpAlertsEnabled: true,
  whaleSellUsd: 300,
  whaleSellLiquidityPct: 2,
  dumpWindowMin: 3,
  // Utility-score thresholds: hide below minScore, flag gems at gemMinScore.
  minScore: 2,
  gemMinScore: 4,
  // Compact per-card safety readout (🛡 N/7) in each Pulse card's corner.
  cardIntelEnabled: true,
  // Per-metric hard hide rules (see BBD.HIDE_METRICS). Each: hide any token
  // whose stat exceeds the max %, regardless of utility. Held tokens and
  // "always show" overrides are never hidden. top-10 on by default; the rest
  // opt-in so the feed isn't suddenly gutted for people upgrading.
  hide_top10_on: true, hide_top10_max: 40,
  hide_insiders_on: false, hide_insiders_max: 20,
  hide_bundlers_on: false, hide_bundlers_max: 30,
  hide_snipers_on: false, hide_snipers_max: 30,
  hide_dev_on: false, hide_dev_max: 10,
  // Buy/sell tax ceiling — token-page 🛡 verdict only (tax isn't on the feed).
  maxTaxPct: 10,
  // 🔥 best-guess highlight: card must pass every on-card safety metric AND
  // carry a utility signal. Thresholds derived from the profile shared by
  // verified runners (PONS, Index, wire) vs farms (RYFT: top10 82%, insiders 67%).
  hotEnabled: true,
  // Laptop-side 🔥 Telegram sends. Turn OFF if a VPS watcher already covers
  // discovery — otherwise both sources alert the same token once each.
  laptopHotAlerts: true,
  hotMaxTop10: 30,
  hotMaxDev: 2,
  hotMaxSnipers: 15,
  hotMaxBundlers: 15,
  hotMaxInsiders: 20,
  hotMinHolders: 100,
  hotMinProRatio: 0.05,
  hotMaxProRatio: 0.6,
  hotMinUtilityScore: 2, // social/badge evidence only — stat bonus must NOT count toward this
  // Dev/creator guard: flag tokens whose creator is a serial launcher or has
  // rugged before. creatorAddress comes from the metrics API, joined with
  // observed market cap/liquidity — a reputation signal no single card shows.
  creatorGuardEnabled: true,
  creatorMaxLaunches: 5,       // >= this many distinct observed tokens => serial farmer
  creatorMaxRugs: 2,           // >= this many observed rugs => flagged
  creatorRugMinPeakUsd: 8000,  // a token must have had a real market to count as a rug
  creatorRugDeadLiqUsd: 800,   // ...and its liquidity must have since collapsed below this
  // Contract/hook audit guard: flag tokens whose contract or Uniswap-v4 hook can
  // drain liquidity, trap LPs or levy hidden fees (from /api/audit/batch).
  auditGuardEnabled: true,
  // Launchpad badges (img alt values on Pulse cards) treated as meme sources.
  // NOTE: memeBadges/memeKeywords + the hot* gates + score.js SOCIAL_WEIGHTS are
  // mirrored in shared/hot-config.json (the VPS watcher reads that file). Keep
  // them in sync — test/config-sync.test.js fails on drift.
  memeBadges: ['Pons', 'bow.fun', 'Flap', 'Circus', 'Charms', 'Long.xyz', 'Bankr', 'Ape Store',
    'Zora', 'Clanker', 'Flaunch', 'Stroid', 'Klik', 'Trench', 'Livo',
    'Pump.fun', 'PumpFun', 'PumpSwap', 'Bags', 'Meteora DBC'],
  // Name/ticker fragments that mark a token as a meme coin.
  memeKeywords: [
    'pepe', 'inu', 'doge', 'shib', 'wif', 'bonk', 'elon', 'trump', 'moon',
    'wojak', 'chad', 'frog', 'cat', 'dog', 'kitty', 'pup', 'baby', 'fart',
    'butt', 'cum', 'tendies', 'rug', 'ape', 'monke', 'gigachad', 'meme'
  ],
  // Read only by the popup + background worker (from raw storage), but kept
  // here so DEFAULT_SETTINGS is the single complete source of truth.
  tgToken: '',
  tgChatId: ''
});

// chrome.storage.local keys.
BBD.KEYS = Object.freeze({
  settings: 'settings',   // user settings (merged over DEFAULT_SETTINGS)
  positions: 'positions', // { [positionKey]: { addr, chain, wallet, pct, sourceTs, ... } }
  snoozes: 'snoozes',     // { [positionKey]: untilTimestampMs }
  dismissed: 'dismissed', // { [positionKey]: pctAtDismissal }
  overrides: 'overrides', // { [addr]: 'hide' | 'show' }
  intel: 'intel',         // { [addr]: parsed Token Info metrics + ts }
  alerted: 'alerted',     // { [addr]: ts } — 🔥 telegram dedupe, 24h TTL
  creators: 'creators',   // { [creatorAddr]: { tokens: { [addr]: {...} }, ts } }
  journal: 'journal',     // { [tradeId]: { positionKey, addr, openTs, closeTs, ... } }
  daystats: 'daystats',   // { lossDismissedDay: 'YYYY-MM-DD' } — per-day guard dismissals
  guardDismissed: 'guardDismissed', // { [tradeId]: ts } — dismissed revenge advisories
  positionsMeta: 'positionsMeta'     // { source, sourceTs, syncedTs } — data-health status
});

// Score penalty for a card whose creator is a flagged serial launcher/rugger.
// Applied in filter.classify (not scoreCard) since it needs the addr → creator
// lookup; matches the launchpad-badge penalty in weight.
BBD.BAD_CREATOR_PENALTY = -3;

// Score penalty for a token the audit flags as drainable/unsafe — heavier than
// a meme badge: this is funds-at-risk, not just noise.
BBD.AUDIT_DANGER_PENALTY = -5;

BBD.STALE_MS = 30 * 60 * 1000;   // position data older than this is labeled stale
BBD.SCAN_DEBOUNCE_MS = 300;
BBD.POLL_MS = 5000;
BBD.ROUTE_POLL_MS = 1000;
BBD.BALANCES_TTL_MS = 2 * 60 * 1000;

// Configurable per-metric hide rules. `stat` is the field name on parsed card
// stats; `label` is the popup wording. Drives DEFAULT_SETTINGS keys
// (hide_<key>_on / hide_<key>_max), the classify() loop, and the popup UI.
BBD.HIDE_METRICS = Object.freeze([
  { key: 'top10', stat: 'top10', label: 'Top-10 holders own >' },
  { key: 'insiders', stat: 'insiders', label: 'Insiders own >' },
  { key: 'bundlers', stat: 'bundlers', label: 'Bundlers own >' },
  { key: 'snipers', stat: 'snipers', label: 'Snipers own >' },
  { key: 'dev', stat: 'dev', label: 'Dev holds >' }
]);

// Short/ambiguous keywords need word boundaries so BUTTERCOIN doesn't match
// "butt" or Catalyst "cat"; distinctive meme words still match as substrings
// (catches concatenations like "catwifhat").
BBD.AMBIGUOUS_KEYWORDS = Object.freeze([
  'cat', 'dog', 'ape', 'butt', 'baby', 'moon', 'pup', 'rug', 'cum', 'meme', 'chad'
]);

BBD.hasMemeKeyword = (text, keywords) => keywords.some((kw) => {
  if (!BBD.AMBIGUOUS_KEYWORDS.includes(kw)) return text.includes(kw);
  return new RegExp(`(^|[^a-z0-9])${kw}([^a-z0-9]|$)`, 'i').test(text);
});

// Social-link titles that count as a real web presence — tokens carrying any
// of these are never auto-hidden, only risk-ranked.
BBD.UTILITY_TITLES = Object.freeze(['Website', 'GitHub', 'MCP', 'Docs', 'Medium', 'YouTube', 'Discord']);

// Every launchpad badge the popup offers as a hide toggle (superset of the
// default memeBadges — includes 'Virtual', which scores a bonus not a penalty).
// Lives here so the popup shares this list instead of keeping its own copy.
BBD.KNOWN_BADGES = Object.freeze(['Pons', 'Virtual', 'bow.fun', 'Flap', 'Circus', 'Charms', 'Bankr',
  'Long.xyz', 'Ape Store', 'Zora', 'Clanker', 'Flaunch', 'Stroid', 'Klik', 'Trench', 'Livo',
  'Pump.fun', 'PumpSwap', 'Bags', 'Meteora DBC']);

// False once the extension is reloaded/removed and this content script is an
// orphan — every chrome.* call would throw from then on.
BBD.alive = () => {
  try {
    return Boolean(chrome.runtime && chrome.runtime.id);
  } catch (err) {
    return false;
  }
};

BBD.tokenAddrFromHref = (href) => {
  if (typeof href !== 'string') return null;
  const m = href.match(/\/token\/[^/]+\/(0x[a-fA-F0-9]{6,}|[1-9A-HJ-NP-Za-km-z]{20,})/);
  if (!m) return null;
  // Hex EVM addresses are case-insensitive — normalize for stable map keys.
  // Base58 Solana addresses are case-SENSITIVE — lowercasing breaks URLs (#5).
  return m[1].startsWith('0x') ? m[1].toLowerCase() : m[1];
};

// Position identity must include chain and wallet: identical EVM contract
// addresses can exist on multiple chains, and BasedBot may expose more than
// one connected wallet. Legacy address-only entries remain readable.
BBD.positionKey = (addr, chain, wallet) => {
  if (!addr) return null;
  const safeChain = String(chain || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'unknown';
  const safeWallet = String(wallet || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  return `${safeChain}|${safeWallet}|${addr}`;
};

BBD.positionAddr = (key, position) => {
  if (position && position.addr) return position.addr;
  const raw = String(key || '');
  return raw.includes('|') ? raw.slice(raw.lastIndexOf('|') + 1) : raw;
};

BBD.positionIsToken = (key, position, addr, chain) => {
  if (!addr || BBD.positionAddr(key, position) !== addr) return false;
  if (!chain || !position || !position.chain) return true;
  return String(position.chain).toLowerCase() === String(chain).toLowerCase();
};

BBD.isHeld = (positions, addr, chain) => Object.entries(positions || {})
  .some(([key, p]) => BBD.positionIsToken(key, p, addr, chain) &&
    Date.now() - (p && (p.sourceTs || p.ts) || 0) <= BBD.STALE_MS);

// Local-day key, unlike toISOString(), agrees with the local-midnight logic
// used by the daily-loss guard around timezone boundaries.
BBD.localDayKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

// Page-controlled text (token symbols/names) goes into Telegram messages and
// notification titles. Strip anything that could turn our own alert channel
// into a phishing surface: URLs, handles, control/RTL-override chars (#8).
BBD.sanitizeAlertText = (text, maxLen = 48) => {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/(?:https?:\/\/|www\.|t\.me\/|@)\S+/gi, '')
    .replace(/\S+\.(?:com|io|net|org|app|xyz|fun|finance|trade|money|st)\b\S*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
};

BBD.parsePct = (text) => {
  if (typeof text !== 'string') return null;
  const m = text.replace(/,/g, '').match(/\(?\s*([+-]?\d+(?:\.\d+)?)\s*%\s*\)?/);
  return m ? Number(m[1]) : null;
};
