// Utility scoring: one number per token card, used both to hide memes
// (score below minScore) and to flag gems (score at/above gemMinScore).
'use strict';

// Social link titles on cards, weighted by how hard they are to fake-signal.
// Every meme has a Telegram; almost none have a GitHub or docs.
BBD.SOCIAL_WEIGHTS = Object.freeze({
  GitHub: 4,
  MCP: 4,
  Docs: 3,
  Medium: 1,
  YouTube: 1,
  Website: 1,
  Discord: 1,
  Telegram: 0,
  X: 0,
  Twitter: 0,
  Instagram: 0,
  Facebook: 0,
  Reddit: 0
});

BBD.MEME_BADGE_PENALTY = -3;  // launched on a pump-style meme pad
BBD.VIRTUAL_BONUS = 1;        // agent platform: mild positive, not decisive
BBD.KEYWORD_PENALTY = -3;     // meme-named

// On-card safety stats earn points back — a launchpad badge alone shouldn't
// bury a token whose holder structure is clean (matches the filters credible
// traders repeat: top10 <30%, low dev/snipers/bundlers/insiders, Dex Paid).
// Gated on ≥50 holders so brand-new launches (all stats 0%) can't fake clean.
BBD.statBonus = (stats) => {
  if (!stats || stats.holders === null || stats.holders < 50) return 0;
  let bonus = 0;
  if (stats.paid) bonus += 1;
  if (stats.dev <= 2) bonus += 1;
  if (stats.snipers <= 10 && stats.bundlers <= 10) bonus += 1;
  if (stats.insiders <= 10) bonus += 1;
  if (stats.top10 <= 30) bonus += 1;
  if (stats.holders >= 300) bonus += 1;
  return bonus;
};

BBD.scoreCard = (info, settings) => {
  let score = 0;
  if (info.badges.some((b) => settings.memeBadges.includes(b))) {
    score += BBD.MEME_BADGE_PENALTY;
  }
  if (info.badges.includes('Virtual')) score += BBD.VIRTUAL_BONUS;
  if (BBD.hasMemeKeyword(info.nameBlob, settings.memeKeywords)) {
    score += BBD.KEYWORD_PENALTY;
  }
  for (const title of info.titles) {
    const w = BBD.SOCIAL_WEIGHTS[title];
    if (typeof w === 'number') score += w;
  }
  return score;
};
