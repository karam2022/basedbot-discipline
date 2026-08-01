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
      ...parseTax(),
      ts: Date.now()
    };
  };

  // Buy/sell tax lives only on the token page as "Tax B/S  10/10%" (not on the
  // feed). Returns { buyTax, sellTax } as numbers, or nulls if absent.
  const parseTax = () => {
    const m = document.body.innerText.match(/Tax\s*B\/S\s*([\d.]+)\s*\/\s*([\d.]+)\s*%/i);
    return m
      ? { buyTax: Number(m[1]), sellTax: Number(m[2]) }
      : { buyTax: null, sellTax: null };
  };

  // The Solana token page carries neither a Tax row nor a meaningful
  // "Renounced" value, but api/2/token/security carries both plus the two SPL
  // authorities. Fold it in so the chip reads from everything available rather
  // than only from what the panel happens to render (docs/solana-support.md §3).
  const withSecurity = (m, addr) => {
    const sec = addr && BBD.feed.securityFor ? BBD.feed.securityFor(addr) : null;
    if (!sec) return m;
    const merged = { ...m };
    // The panel wins where it has a value; the API only fills the gaps.
    if (merged.buyTax === null && sec.buyTax !== null) merged.buyTax = sec.buyTax;
    if (merged.sellTax === null && sec.sellTax !== null) merged.sellTax = sec.sellTax;
    if (merged.top10 === null && sec.top10 !== null) merged.top10 = sec.top10;
    merged.mintable = sec.mintable;
    merged.freezable = sec.freezable;
    return merged;
  };

  // Each check: [name, pass|null]. null = unknown OR not applicable on this
  // chain — either way it leaves the denominator instead of sitting there as a
  // silent pass or an uninformative failure.
  const runChecks = (m, settings, chain) => {
    const can = (capability) =>
      !BBD.chain || BBD.chain.supports(chain, capability);
    const checks = [
      ['Top10 ≤30%', m.top10 === null ? null : m.top10 <= settings.hotMaxTop10],
      ['Dev ≤2%', m.dev === null ? null : m.dev <= settings.hotMaxDev],
      ['Snipers ≤15%', m.snipers === null ? null : m.snipers <= settings.hotMaxSnipers],
      ['Insiders ≤20%', m.insiders === null ? null : m.insiders <= settings.hotMaxInsiders],
      ['Bundlers ≤15%', m.bundlers === null ? null : m.bundlers <= settings.hotMaxBundlers],
      // Where Dex Paid does not gate 🔥 it must not fail the chip either: on
      // Solana all but ~0.3% of tokens are Unpaid, so a red mark there says
      // nothing about the token. Paying still earns the pass.
      ['Dex Paid', can('dexPaidGate') ? m.dexPaid : (m.dexPaid === true ? true : null)],
      ['LP burned/locked', (m.lpBurned === null && m.lpLocked === null)
        ? null : (m.lpBurned >= 50 || m.lpLocked >= 50)],
      // EVM ownership renounce. Solana shows "—" here; its equivalent is the
      // pair of SPL authorities below.
      ['Renounced', can('renounced') ? m.renounced : null],
      ['Holders ≥100', m.holders === null ? null : m.holders >= settings.hotMinHolders],
      [`Tax ≤${settings.maxTaxPct}%`, (m.buyTax === null && m.sellTax === null)
        ? null : (Math.max(m.buyTax || 0, m.sellTax || 0) <= settings.maxTaxPct)]
    ];
    // An active freeze authority can block the holder's sell and an active mint
    // authority can dilute the supply at will — the two facts that decide
    // whether a Solana position can be exited at all.
    if (can('mintAuthority')) {
      checks.push(['Mint revoked',
        m.mintable === null || m.mintable === undefined ? null : m.mintable === false]);
    }
    if (can('freezeAuthority')) {
      checks.push(['Freeze revoked',
        m.freezable === null || m.freezable === undefined ? null : m.freezable === false]);
    }
    return checks;
  };

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
    if (BBD.drag) BBD.drag.register(el);
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
      const chain = BBD.chain ? BBD.chain.route() : null;
      renderVerdict(runChecks(withSecurity(metrics, addr), settings, chain), rep, danger);
      if (addr) await BBD.store.mergeEntry(BBD.KEYS.intel, addr, metrics);
    } catch (err) {
      console.warn('[bbd] intel scan failed', err);
    }
  };

  return { scan };
})();
