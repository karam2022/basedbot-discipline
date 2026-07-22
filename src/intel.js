// Token-page intel: auto-expands the Token Info panel, parses every safety
// metric (incl. LP Burned/Locked, Renounced, Token Burn — fields Pulse cards
// don't carry), caches it, and renders a verdict chip on the page.
'use strict';

BBD.intel = (() => {
  const LABELS = [
    'Top 10 H.', 'Dev H.', 'Snipers H.', 'Insiders', 'Bundlers', 'Renounced',
    'LP Burned', 'LP Locked', 'Token Burn', 'Holders', 'Pro Traders',
    'Dex Paid', 'Fees Paid'
  ];

  const pctNum = (t) => {
    if (typeof t !== 'string') return null;
    if (t.startsWith('<')) return 0.5;
    const m = t.match(/^(\d+(?:\.\d+)?)%$/);
    return m ? Number(m[1]) : null;
  };
  const countNum = (t) => {
    const m = (t || '').match(/^([\d.]+)(K|M)?$/);
    return m ? Number(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1) : null;
  };

  // Auto-expand at most once per token per page session (#7): if the user
  // collapses the panel afterwards, that's their call — don't fight them.
  const autoExpanded = new Set();
  const expandPanel = (addr) => {
    if (document.body.innerText.includes('Top 10 H.')) return;
    if (addr && autoExpanded.has(addr)) return;
    const btn = [...document.querySelectorAll('button')]
      .find((el) => el.textContent.trim() === 'Token Info');
    if (!btn) return;
    if (addr) autoExpanded.add(addr);
    btn.click();
  };

  // Values render BEFORE their label ("19% § Top 10 H.").
  const parsePanel = () => {
    const lines = document.body.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.includes('Top 10 H.')) return null;
    const raw = {};
    for (const label of LABELS) {
      const idx = lines.indexOf(label);
      raw[label] = idx > 0 ? lines[idx - 1] : null;
    }
    return {
      top10: pctNum(raw['Top 10 H.']),
      dev: pctNum(raw['Dev H.']),
      snipers: pctNum(raw['Snipers H.']),
      insiders: pctNum(raw['Insiders']),
      bundlers: pctNum(raw['Bundlers']),
      renounced: raw['Renounced'] === '—' || raw['Renounced'] === null
        ? null : !/no|—/i.test(raw['Renounced']),
      lpBurned: pctNum(raw['LP Burned']),
      lpLocked: pctNum(raw['LP Locked']),
      tokenBurn: pctNum((raw['Token Burn'] || '').replace(/%?$/, '%')),
      holders: countNum(raw['Holders']),
      proTraders: countNum(raw['Pro Traders']),
      dexPaid: raw['Dex Paid'] === 'Paid',
      ts: Date.now()
    };
  };

  // Each check: [name, pass|null]. null = unknown, doesn't count against.
  const runChecks = (m, settings) => [
    ['Top10 ≤30%', m.top10 === null ? null : m.top10 <= settings.hotMaxTop10],
    ['Dev ≤2%', m.dev === null ? null : m.dev <= settings.hotMaxDev],
    ['Snipers ≤15%', m.snipers === null ? null : m.snipers <= settings.hotMaxSnipers],
    ['Insiders ≤20%', m.insiders === null ? null : m.insiders <= settings.hotMaxInsiders],
    ['Bundlers ≤15%', m.bundlers === null ? null : m.bundlers <= settings.hotMaxBundlers],
    ['Dex Paid', m.dexPaid],
    ['LP burned/locked', (m.lpBurned === null && m.lpLocked === null)
      ? null : (m.lpBurned >= 50 || m.lpLocked >= 50)],
    ['Renounced', m.renounced],
    ['Holders ≥100', m.holders === null ? null : m.holders >= settings.hotMinHolders]
  ];

  // One-line summary of the creator's track record, or '' when there's nothing
  // worth saying (unknown dev, or a single clean launch).
  const devNote = (rep) => {
    if (!rep || !rep.creatorAddr || (!rep.flagged && rep.launchCount <= 1)) return '';
    const launches = `${rep.launchCount} launch${rep.launchCount === 1 ? '' : 'es'}`;
    const rugs = rep.ruggedCount ? `, ${rep.ruggedCount} rugged` : '';
    return ` · 👤 dev: ${launches}${rugs}${rep.flagged ? ' ⚠️' : ''}`;
  };

  const renderVerdict = (checks, rep, danger) => {
    let el = document.getElementById('bbd-intel');
    if (!el || !el.isConnected) {
      el = document.createElement('div');
      el.id = 'bbd-intel';
      document.body.appendChild(el);
    }
    const passed = checks.filter(([, v]) => v === true);
    const failed = checks.filter(([, v]) => v === false);
    // A flagged creator or a drainable contract forces the chip red even if the
    // token's own snapshot looks clean — the whole point of the guards.
    const cls = (danger && danger.danger) || (rep && rep.flagged) ? 'bbd-bad'
      : failed.length === 0 ? 'bbd-good' : failed.length <= 2 ? 'bbd-warn' : 'bbd-bad';
    el.className = cls;
    const failText = failed.length
      ? ' · ⚠️ ' + failed.map(([n]) => n).join(', ')
      : ' · clean';
    const dangerNote = danger && danger.danger
      ? ` · ⛔ ${danger.reasons[0] || 'contract can drain liquidity'}`
      : '';
    el.textContent = `🛡 ${passed.length}/${checks.length - checks.filter(([, v]) => v === null).length} checks${failText}${devNote(rep)}${dangerNote}`;
    el.style.display = 'block';
  };

  const scan = async () => {
    if (!location.pathname.includes('/token/')) {
      const el = document.getElementById('bbd-intel');
      if (el) el.style.display = 'none';
      return;
    }
    try {
      const settings = await BBD.store.settings();
      const addr = BBD.tokenAddrFromHref(location.pathname);
      expandPanel(addr);
      const metrics = parsePanel();
      if (!metrics) return;
      // Record this token under its creator, then read the dev's track record.
      let rep = null;
      if (addr && settings.creatorGuardEnabled) {
        BBD.creator.observe(addr, BBD.feed.creatorFor(addr), BBD.feed.marketFor(addr));
        rep = BBD.creator.verdictFor(addr, settings);
      }
      const danger = addr && settings.auditGuardEnabled ? BBD.feed.auditFor(addr) : null;
      renderVerdict(runChecks(metrics, settings), rep, danger);
      if (addr) await BBD.store.mergeEntry(BBD.KEYS.intel, addr, metrics);
    } catch (err) {
      console.warn('[bbd] intel scan failed', err);
    }
  };

  return { scan };
})();
