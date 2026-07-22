// Meme-coin filter + gem highlighter for Pulse pages. Cards are
// <a href="/token/...">; launchpad badges are <img alt> values after the
// token logo; social links carry title attributes (Website, GitHub, Docs...).
'use strict';

BBD.filter = (() => {
  let hiddenCount = 0;
  let gemCount = 0;
  let hotCount = 0;
  let peeking = false;
  let filterOn = true; // reflects settings.filterEnabled for the chip label
  let hiOn = true;     // reflects settings.hotEnabled for the chip label
  const hotSeen = new Set(); // addrs already notified this session

  const isPulse = () => location.pathname.startsWith('/pulse');

  const cardInfo = (card) => {
    const addr = BBD.tokenAddrFromHref(card.getAttribute('href') || '');
    const alts = [...card.querySelectorAll('img')]
      .map((img) => (img.alt || '').trim())
      .filter(Boolean);
    const symbol = alts[0] || ''; // the token logo's alt is the symbol
    const badges = alts.slice(1);
    // Social evidence from the card's [title] icons, unioned with the links
    // the metadata API reported (cards truncate icons; the API doesn't).
    const titles = [...new Set([
      ...[...card.querySelectorAll('[title]')]
        .map((el) => (el.getAttribute('title') || '').trim())
        .filter(Boolean),
      ...BBD.feed.titlesFor(addr)
    ])];
    const lines = card.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
    const nameBlob = lines.slice(0, 2).join(' ').toLowerCase();
    return { addr, symbol, badges, titles, nameBlob };
  };

  // DOM fallback for when the API cache misses (BBD.feed.statsFor is primary).
  // On-card stat row, verified positional order (checked against the Token
  // Info panel): holders, proTraders, Top10%, Dev%, Snipers%, Bundlers%,
  // Insiders%, then a Paid/No dex-paid badge. Returns null when the row
  // hasn't rendered yet (brand-new pairs).
  const parseCardStats = (card) => {
    const leaves = [...card.querySelectorAll('span,div')]
      .filter((el) => el.childElementCount === 0)
      .map((el) => el.textContent.trim())
      .filter(Boolean);
    const pctNum = (t) => (t.startsWith('<') ? 0.5 : Number(t.replace('%', '')));
    const countNum = (t) => {
      const m = t.match(/^([\d.]+)(K|M)?$/);
      if (!m) return null;
      const mult = m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1;
      return Number(m[1]) * mult;
    };
    const pctIdx = leaves
      .map((t, i) => (/^<?\d+(\.\d+)?%$/.test(t) ? i : -1))
      .filter((i) => i >= 0);
    if (pctIdx.length < 5) return null;
    // Layout canary (#6): the positional mapping assumes a known card shape.
    // If basedbot adds stats or values go absurd, refuse to score rather than
    // silently mislabel snipers as insiders.
    if (pctIdx.length > 8) return layoutSuspect('too many % values on card');
    const last5 = pctIdx.slice(-5);
    const [top10, dev, snipers, bundlers, insiders] = last5.map((i) => pctNum(leaves[i]));
    if ([top10, dev, snipers, bundlers, insiders].some((v) => !(v >= 0 && v <= 100))) {
      return layoutSuspect('percentage out of 0-100 range');
    }
    const holders = countNum(leaves[last5[0] - 2] || '');
    const pro = countNum(leaves[last5[0] - 1] || '');
    const paid = leaves.includes('Paid');
    if (holders === null || pro === null) return null;
    return { holders, pro, top10, dev, snipers, bundlers, insiders, paid };
  };

  let layoutWarned = false;
  const layoutSuspect = (why) => {
    if (!layoutWarned) {
      layoutWarned = true;
      console.warn(`[bbd] card layout changed? (${why}) — stat scoring disabled for unmatched cards`);
    }
    return null;
  };

  const isHot = (stats, utilityScore, settings) => {
    if (!settings.hotEnabled || !stats || !stats.paid) return false;
    const proRatio = stats.holders > 0 ? stats.pro / stats.holders : 0;
    return (
      utilityScore >= settings.hotMinUtilityScore &&
      stats.top10 <= settings.hotMaxTop10 &&
      stats.dev <= settings.hotMaxDev &&
      stats.snipers <= settings.hotMaxSnipers &&
      stats.bundlers <= settings.hotMaxBundlers &&
      stats.insiders <= settings.hotMaxInsiders &&
      stats.holders >= settings.hotMinHolders &&
      proRatio >= settings.hotMinProRatio &&
      proRatio <= settings.hotMaxProRatio
    );
  };

  // Cached token-page intel sweetens the score for tokens you've inspected:
  // LP burned/locked and renounced contracts are signals cards can't show.
  const intelBonus = (addr, intel) => {
    const m = addr && intel[addr];
    if (!m) return 0;
    let bonus = 0;
    if (m.lpBurned >= 50 || m.lpLocked >= 50) bonus += 2;
    if (m.renounced === true) bonus += 1;
    return bonus;
  };

  // Returns 'show' | 'hide' | 'gem' | 'hot'. Stats computed once by the
  // caller (#7) and shared with the alert path; badDev (creator-guard) and
  // danger (audit-guard) verdicts are likewise computed once so the class
  // toggles and score agree.
  const classify = (stats, info, settings, overrides, positions, intel, badDev, danger) => {
    // Social evidence only — clean holder stats must never buy a meme into 🔥
    // (PONSINU lesson), so the stat bonus counts toward hide/gem but not hot.
    const social = BBD.scoreCard(info, settings) + intelBonus(info.addr, intel);
    const score = social + BBD.statBonus(stats)
      + (badDev ? BBD.BAD_CREATOR_PENALTY : 0)
      + (danger ? BBD.AUDIT_DANGER_PENALTY : 0);
    const kwHit = BBD.hasMemeKeyword(info.nameBlob, settings.memeKeywords);
    // A flagged creator or a drainable contract can never buy a token into 🔥 —
    // reputation/audit outweigh a clean-looking holder snapshot (the snapshot is
    // exactly what ruggers optimize).
    const hot = !kwHit && !badDev && !danger && isHot(stats, social, settings);
    const gem = score >= settings.gemMinScore;
    const positive = hot ? 'hot' : gem ? 'gem' : 'show';
    if (info.addr && positions[info.addr]) return positive; // held: never hide
    if (info.addr && overrides[info.addr] === 'show') return positive;
    if (info.addr && overrides[info.addr] === 'hide') return 'hide';
    if (hot || gem) return positive;
    // Meme-named tokens hide regardless; anything with a real web presence
    // never hides — utility is shown and risk-ranked, not censored.
    if (kwHit) return 'hide';
    if (info.titles.some((t) => BBD.UTILITY_TITLES.includes(t))) return 'show';
    return score < settings.minScore ? 'hide' : 'show';
  };

  const ensureChip = () => {
    let chip = document.getElementById('bbd-filter-chip');
    if (chip && chip.isConnected) return chip;
    chip = document.createElement('button');
    chip.id = 'bbd-filter-chip';
    chip.type = 'button';
    chip.addEventListener('click', () => {
      peeking = !peeking;
      document.documentElement.classList.toggle('bbd-peek', peeking);
      render();
    });
    document.body.appendChild(chip);
    return chip;
  };

  // DOM writes happen ONLY when the value changed (#4): setting textContent
  // replaces a text node, which is a childList mutation our own observer sees
  // — unconditional writes made every scan schedule the next one, forever.
  const setText = (el, text) => {
    if (el.textContent !== text) el.textContent = text;
  };

  const ensureOverrideBtn = (card, info, state) => {
    if (!info.addr) return;
    let btn = card.querySelector('.bbd-override');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'bbd-override';
      btn.type = 'button';
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const wantedState = card.classList.contains('bbd-hidden') ? 'show' : 'hide';
        await BBD.store.mergeEntry(BBD.KEYS.overrides, info.addr, wantedState);
        BBD.filter.scan();
      });
      card.style.position = 'relative';
      card.appendChild(btn);
    }
    setText(btn, state === 'hide' ? '✓ keep' : '🚫');
    const title = state === 'hide' ? 'Always show this token' : 'Always hide this token';
    if (btn.title !== title) btn.title = title;
  };

  // Compact per-card safety readout. The 7 base checks come from card-visible
  // stats (the same the 🔥 gate uses). LP-burn/lock and renounce aren't on
  // cards — but intel.js caches them from the token panel, so for any token
  // you've opened the card verdict upgrades to the full 9-check set (matching
  // the token-page chip) rather than staying a subset.
  const cardChecks = (stats, s, cached) => {
    const checks = [
      [`Top10 ≤${s.hotMaxTop10}%`, stats.top10 <= s.hotMaxTop10],
      [`Dev ≤${s.hotMaxDev}%`, stats.dev <= s.hotMaxDev],
      [`Snipers ≤${s.hotMaxSnipers}%`, stats.snipers <= s.hotMaxSnipers],
      [`Bundlers ≤${s.hotMaxBundlers}%`, stats.bundlers <= s.hotMaxBundlers],
      [`Insiders ≤${s.hotMaxInsiders}%`, stats.insiders <= s.hotMaxInsiders],
      ['Dex Paid', stats.paid],
      [`Holders ≥${s.hotMinHolders}`, stats.holders >= s.hotMinHolders]
    ];
    if (cached) {
      if (typeof cached.lpBurned === 'number' || typeof cached.lpLocked === 'number') {
        checks.push(['LP burned/locked', cached.lpBurned >= 50 || cached.lpLocked >= 50]);
      }
      if (cached.renounced === true || cached.renounced === false) {
        checks.push(['Renounced', cached.renounced]);
      }
    }
    return checks;
  };

  const ensureCardIntel = (card, stats, settings, cached, show) => {
    let el = card.querySelector('.bbd-cardintel');
    if (!show || !stats) {
      if (el && el.style.display !== 'none') el.style.display = 'none';
      return;
    }
    if (!el) {
      el = document.createElement('span');
      el.className = 'bbd-cardintel';
      card.style.position = 'relative';
      card.appendChild(el);
    }
    const checks = cardChecks(stats, settings, cached);
    const failed = checks.filter(([, v]) => v === false);
    const cls = `bbd-cardintel ${failed.length === 0 ? 'bbd-ci-good'
      : failed.length <= 2 ? 'bbd-ci-warn' : 'bbd-ci-bad'}`;
    if (el.className !== cls) el.className = cls;
    setText(el, `🛡 ${checks.length - failed.length}/${checks.length}`);
    const title = failed.length
      ? 'Risk: ' + failed.map(([n]) => n).join(', ')
      : 'All card safety checks pass';
    if (el.title !== title) el.title = title;
    if (el.style.display !== 'block') el.style.display = 'block';
  };

  const render = () => {
    const chip = ensureChip();
    const gems = gemCount > 0 ? ` · ${gemCount} 💎` : '';
    const hots = hotCount > 0 ? ` · ${hotCount} 🔥` : '';
    const hidePart = filterOn
      ? (peeking
        ? `👁 peeking · ${hiddenCount} memecoins — hide again`
        : `🚫 ${hiddenCount} memecoins hidden`)
      : '💡 highlights on'; // hiding disabled — chip still surfaces gems/🔥
    setText(chip, `${hidePart}${gems}${hots}`);
    const display =
      isPulse() && (hiddenCount > 0 || gemCount > 0 || hotCount > 0) ? 'block' : 'none';
    if (chip.style.display !== display) chip.style.display = display;
  };

  // 🔥 alerts go to Telegram ONLY (background routes on target) — Chrome
  // notifications are reserved for take-profit on held positions.
  // Real dedupe lives in the background worker, which serializes checks across
  // all tabs (#3); hotSeen just avoids re-messaging every scan pass.
  const notifyHot = (info, settings, stats) => {
    if (!settings.laptopHotAlerts) return;
    if (!info.addr || hotSeen.has(info.addr)) return;
    hotSeen.add(info.addr);
    const chain = (location.pathname.match(/^\/pulse\/([^/]+)/) || [])[1];
    const statLine = stats
      ? ` top10 ${stats.top10}% · dev ${stats.dev}% · snipers ${stats.snipers}% · ` +
        `insiders ${stats.insiders}% · ${stats.holders} holders.`
      : '';
    const symbol = BBD.sanitizeAlertText(info.symbol, 20) || info.addr.slice(0, 8);
    try {
      chrome.runtime.sendMessage({
        type: 'bbd-notify',
        target: 'telegram',
        dedupe: { key: `hot:${info.addr}` },
        title: '🔥 Best guess on Pulse (laptop)',
        message: `${symbol} passes every safety metric.${statLine}`,
        url: chain ? `${location.origin}/token/${chain}/${info.addr}` : undefined
      });
    } catch (err) {
      console.warn('[bbd] hot notify failed', err);
    }
  };

  const scan = async () => {
    if (!isPulse()) {
      teardown();
      return;
    }
    const settings = await BBD.store.settings();
    filterOn = settings.filterEnabled;
    hiOn = settings.hotEnabled;
    // Hiding and highlighting are independent (v1.8.2): only bail when BOTH are
    // off, so turning off "Hide meme coins" no longer kills 🔥/💎 highlights.
    if (!filterOn && !hiOn) {
      teardown();
      return;
    }
    const [overrides, positions, intel] = await Promise.all([
      BBD.store.get(BBD.KEYS.overrides, {}),
      BBD.store.get(BBD.KEYS.positions, {}),
      BBD.store.get(BBD.KEYS.intel, {})
    ]);
    // Scope to the Pulse feed columns only (#9): search results, address
    // matches and sidebars render OUTSIDE the grid and must never be hidden —
    // the user explicitly asked to see those.
    const feedRoot = document.querySelector('.grid-cols-3') || document;
    const cards = [...feedRoot.querySelectorAll('a[href*="/token/"]')]
      .filter((a) => BBD.tokenAddrFromHref(a.getAttribute('href') || ''));
    let hidden = 0;
    let gems = 0;
    let hots = 0;
    for (const card of cards) {
      const info = cardInfo(card);
      // API cache (immune to layout changes) is primary; the positional DOM
      // parser is the fallback for cards no batch has covered yet.
      const stats = BBD.feed.statsFor(info.addr) || parseCardStats(card);
      // Feed the creator-reputation model, then read its verdict for this card.
      let badDev = false;
      if (settings.creatorGuardEnabled && info.addr) {
        BBD.creator.observe(info.addr, BBD.feed.creatorFor(info.addr), BBD.feed.marketFor(info.addr));
        badDev = BBD.creator.isFlagged(info.addr, settings);
      }
      const auditV = settings.auditGuardEnabled && info.addr ? BBD.feed.auditFor(info.addr) : null;
      const danger = !!(auditV && auditV.danger);
      const state = classify(stats, info, settings, overrides, positions, intel, badDev, danger);
      // Each gate independent (v1.8.2): hiding follows filterEnabled, highlights
      // follow hotEnabled — a token can be highlighted while hiding is off, and
      // hidden while highlights are off.
      const doHide = filterOn && state === 'hide';
      const doGem = hiOn && state === 'gem';
      const doHot = hiOn && state === 'hot';
      card.classList.toggle('bbd-hidden', doHide);
      card.classList.toggle('bbd-gem', doGem);
      card.classList.toggle('bbd-hot', doHot);
      // Warning markers ride on visibility (!doHide), not the raw verdict: a
      // held/kept/unhidden token still shows its dev/contract risk.
      card.classList.toggle('bbd-baddev', badDev && !danger && !doHide);
      card.classList.toggle('bbd-danger', danger && !doHide);
      // intel[addr] (cached token-panel scrape) adds LP-burn/lock + renounce to
      // the card verdict for any token you've previously opened.
      ensureCardIntel(card, stats, settings, intel[info.addr], settings.cardIntelEnabled && !doHide);
      if (doHide) hidden += 1;
      if (doGem) gems += 1;
      if (doHot) {
        hots += 1;
        notifyHot(info, settings, stats);
      }
      ensureOverrideBtn(card, info, state);
    }
    // Anything marked outside the feed (stale classes, search overlays) gets
    // unmarked — only feed cards may ever be hidden.
    if (feedRoot !== document) {
      document.querySelectorAll('.bbd-hidden, .bbd-gem, .bbd-hot, .bbd-baddev, .bbd-danger').forEach((el) => {
        if (!feedRoot.contains(el)) {
          el.classList.remove('bbd-hidden', 'bbd-gem', 'bbd-hot', 'bbd-baddev', 'bbd-danger');
        }
      });
    }
    hiddenCount = hidden;
    gemCount = gems;
    hotCount = hots;
    render();
  };

  const teardown = () => {
    document.querySelectorAll('.bbd-hidden, .bbd-gem, .bbd-hot, .bbd-baddev, .bbd-danger').forEach((el) => {
      el.classList.remove('bbd-hidden', 'bbd-gem', 'bbd-hot', 'bbd-baddev', 'bbd-danger');
    });
    document.querySelectorAll('.bbd-cardintel').forEach((el) => { el.style.display = 'none'; });
    const chip = document.getElementById('bbd-filter-chip');
    if (chip) chip.style.display = 'none';
    hiddenCount = 0;
    gemCount = 0;
    hotCount = 0;
  };

  return { scan, teardown };
})();
