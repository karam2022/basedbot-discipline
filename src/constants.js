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
  // Trade journal: log every position's entry safety snapshot, peak, and
  // realized exit so the popup can show win rate and profit given back.
  journalEnabled: true,
  // Anti-FOMO guards (driven by the journal): a daily losing-trade limit that
  // shows a "step away" overlay, and a revenge-trade warning when you reopen a
  // token you just closed at a loss.
  fomoGuardEnabled: true,
  dailyLossLimit: 3,
  revengeWindowMin: 60,
  // Utility-score thresholds: hide below minScore, flag gems at gemMinScore.
  minScore: 2,
  gemMinScore: 4,
  // Compact per-card safety readout (🛡 N/7) in each Pulse card's corner.
  cardIntelEnabled: true,
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
  // Launchpad badges (img alt values on Pulse cards) treated as meme sources.
  memeBadges: ['Pons', 'bow.fun', 'Flap', 'Circus', 'Charms', 'Long.xyz', 'Bankr', 'Ape Store',
    'Zora', 'Clanker', 'Flaunch', 'Stroid', 'Klik', 'Trench', 'Livo',
    'Pump.fun', 'PumpFun', 'PumpSwap', 'Bags', 'Meteora DBC'],
  // Name/ticker fragments that mark a token as a meme coin.
  memeKeywords: [
    'pepe', 'inu', 'doge', 'shib', 'wif', 'bonk', 'elon', 'trump', 'moon',
    'wojak', 'chad', 'frog', 'cat', 'dog', 'kitty', 'pup', 'baby', 'fart',
    'butt', 'cum', 'tendies', 'rug', 'ape', 'monke', 'gigachad', 'meme'
  ]
});

// chrome.storage.local keys.
BBD.KEYS = Object.freeze({
  settings: 'settings',   // user settings (merged over DEFAULT_SETTINGS)
  positions: 'positions', // { [addr]: { symbol, pct, usd, ts } }
  snoozes: 'snoozes',     // { [addr]: untilTimestampMs }
  dismissed: 'dismissed', // { [addr]: pctAtDismissal }
  overrides: 'overrides', // { [addr]: 'hide' | 'show' }
  intel: 'intel',         // { [addr]: parsed Token Info metrics + ts }
  alerted: 'alerted',     // { [addr]: ts } — 🔥 telegram dedupe, 24h TTL
  creators: 'creators',   // { [creatorAddr]: { tokens: { [addr]: {...} }, ts } }
  journal: 'journal',     // { [addr]: { symbol, openTs, closeTs, entryVerdict, peakPct, exitPct, status } }
  daystats: 'daystats'    // { lossDismissedDay: 'YYYY-MM-DD' } — per-day guard dismissals
});

// Score penalty for a card whose creator is a flagged serial launcher/rugger.
// Applied in filter.classify (not scoreCard) since it needs the addr → creator
// lookup; matches the launchpad-badge penalty in weight.
BBD.BAD_CREATOR_PENALTY = -3;

BBD.STALE_MS = 30 * 60 * 1000;   // position data older than this is labeled stale
BBD.SCAN_DEBOUNCE_MS = 300;
BBD.POLL_MS = 5000;
BBD.ROUTE_POLL_MS = 1000;

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
