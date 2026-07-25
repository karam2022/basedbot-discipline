// Popup settings UI (OpenGov 2.0 monochrome). Schema-driven so every tunable
// parameter is editable; content scripts react via chrome.storage.onChanged.
'use strict';

const DEFAULTS = {
  filterEnabled: true,
  hotEnabled: true,
  laptopHotAlerts: true,
  reminderEnabled: true,
  notifyEnabled: false,
  thresholdPct: 20,
  snoozeMin: 15,
  refireStepPct: 10,
  minScore: 2,
  gemMinScore: 4,
  hide_top10_on: true, hide_top10_max: 40,
  hide_insiders_on: false, hide_insiders_max: 20,
  hide_bundlers_on: false, hide_bundlers_max: 30,
  hide_snipers_on: false, hide_snipers_max: 30,
  hide_dev_on: false, hide_dev_max: 10,
  maxTaxPct: 10,
  hotMaxTop10: 30,
  hotMaxDev: 2,
  hotMaxSnipers: 15,
  hotMaxBundlers: 15,
  hotMaxInsiders: 20,
  hotMinHolders: 100,
  hotMinProRatio: 0.05,
  hotMaxProRatio: 0.6,
  hotMinUtilityScore: 2,
  // Per-card safety readout + risk guards (feed).
  cardIntelEnabled: true,
  priceTickerEnabled: true,
  scalpReadoutEnabled: true,
  scalpMaxSellTaxPct: 10,
  creatorGuardEnabled: true,
  creatorMaxLaunches: 5,
  creatorMaxRugs: 2,
  auditGuardEnabled: true,
  // Position discipline.
  stopLossEnabled: true,
  stopLossPct: 25,
  peakGivebackEnabled: true,
  peakGivebackPct: 15,
  journalEnabled: true,
  // Anti-FOMO guards.
  fomoGuardEnabled: true,
  dailyLossLimit: 3,
  revengeWindowMin: 60,
  revengeToastSec: 10,
  // Dev / whale dump alerts.
  dumpAlertsEnabled: true,
  whaleSellUsd: 300,
  whaleSellLiquidityPct: 2,
  dumpWindowMin: 3,
  exitAlarmEnabled: true,
  exitAlarmDropPct: 8,
  // Read only by the popup + background worker (from raw storage).
  tgToken: '',
  tgChatId: '',
  advisorEnabled: false,
  advisorProvider: '',
  advisorBaseUrl: '',
  advisorModel: '',
  advisorApiKey: '',
  advisorOnDump: false,
  advisorOnBanner: false,
  advisorMaxTokens: 4096,
  advisorNoThinking: false,
  advisorHorizonMin: 10,
  riskFloorEnabled: true,
  advisorFloorLpPct: 50,
  advisorActiveSniperUsd: 500,
  cohortReadoutEnabled: true,
  cohortMinWallets: 12,
  cohortEarlyWindowSec: 60,
  holderReadoutEnabled: true,
  holderMinCount: 20,
  holderClusterMinWallets: 3,
  holderTrackTopN: 10,
  holderTrackWindowSec: 300,
  panelsDraggable: true,
  memeBadges: ['Pons', 'bow.fun', 'Flap', 'Circus', 'Charms', 'Long.xyz', 'Bankr', 'Ape Store',
    'Zora', 'Clanker', 'Flaunch', 'Stroid', 'Klik', 'Trench', 'Livo',
    'Pump.fun', 'PumpFun', 'PumpSwap', 'Bags', 'Meteora DBC'],
  memeKeywords: ['pepe', 'inu', 'doge', 'shib', 'wif', 'bonk', 'elon', 'trump', 'moon',
    'wojak', 'chad', 'frog', 'cat', 'dog', 'kitty', 'pup', 'baby', 'fart',
    'butt', 'cum', 'tendies', 'rug', 'ape', 'monke', 'gigachad', 'meme']
};

const KNOWN_BADGES = [
  'Pons', 'Virtual', 'bow.fun', 'Flap', 'Circus', 'Charms', 'Bankr', 'Long.xyz',
  'Ape Store', 'Zora', 'Clanker', 'Flaunch', 'Stroid', 'Klik', 'Trench', 'Livo',
  'Pump.fun', 'PumpSwap', 'Bags', 'Meteora DBC'
];

const HIDE_METRICS = (self.BBD && BBD.HIDE_METRICS) || [
  { key: 'top10', label: 'Top-10 holders own >' },
  { key: 'insiders', label: 'Insiders own >' },
  { key: 'bundlers', label: 'Bundlers own >' },
  { key: 'snipers', label: 'Snipers own >' },
  { key: 'dev', label: 'Dev holds >' }
];

// [key, label, sub?] — checkboxes.
const TOGGLES = {
  feedToggles: [
    ['filterEnabled', 'Hide meme coins on Pulse'],
    ['hotEnabled', '🔥 / 💎 highlights on Pulse'],
    ['cardIntelEnabled', '🛡 Per-card safety readout', 'Shows a N/7 safety pill on every Pulse card'],
    ['priceTickerEnabled', 'Live price on token page',
      'Polls the trade tape every ~2.5s — no push socket needed'],
    ['scalpReadoutEnabled', 'Scalp readout on token page',
      'Live exit/flow signals for fast flips — no AI, no prediction'],
    ['cohortReadoutEnabled', 'Wallet-behaviour readout',
      'Early-wallet exits, flip rate and one-trade wallets — needs minutes of open tape'],
    ['holderReadoutEnabled', 'Holder-list readout',
      'Funding clusters (real concentration) and share of holders in profit — aggregate only'],
    ['panelsDraggable', 'Draggable panels',
      'Drag the price, scalp, intel and KI cards anywhere; double-click one to reset. A moved panel stops passing clicks through'],
    ['creatorGuardEnabled', '⚠️ Flag risky creators', 'Marks tokens from serial launchers / past ruggers'],
    ['auditGuardEnabled', '⛔ Flag risky contracts', 'Marks tokens whose contract/hook can drain liquidity']
  ],
  tpToggles: [
    ['reminderEnabled', 'Take-profit reminders'],
    ['stopLossEnabled', 'Stop-loss nag', 'Nag when a position falls past your stop-loss'],
    ['peakGivebackEnabled', 'Peak-giveback nag', 'Nag when a winner hands back points from its peak'],
    ['notifyEnabled', 'Chrome notifications', 'Desktop ping when a held position crosses the threshold']
  ],
  journalToggles: [
    ['journalEnabled', 'Keep a trade journal', 'Local-only lifecycle log — win rate, profit given back']
  ],
  fomoToggles: [
    ['fomoGuardEnabled', 'Anti-FOMO guards', 'Daily loss limit + revenge-trade warning']
  ],
  dumpToggles: [
    ['dumpAlertsEnabled', 'Dev / whale dump alerts', 'Watch held tokens for creator or whale sells'],
    ['exitAlarmEnabled', 'AI exit-timing alarm',
      'Ping when a token the AI rated high/critical drops fast — needs a prior KI-Check']
  ],
  tgToggles: [
    ['laptopHotAlerts', '🔥 Telegram alerts from this laptop', 'Turn off if a VPS watcher covers discovery']
  ],
  advisorToggles: [
    ['advisorEnabled', 'Enable AI advisor', 'Opt-in; requests bill to your provider account'],
    ['advisorOnDump', 'Run on dump alerts'],
    ['advisorOnBanner', 'Run on take-profit banners'],
    ['advisorNoThinking', 'Disable provider thinking', 'Faster + more reliable on GLM/Qwen reasoning models'],
    ['riskFloorEnabled', 'Enforce a risk floor', 'Unsafe contract, blocking sell tax or unprotected LP raise the level regardless of the model']
  ]
};

// [key, label, min, max, unit, scale?] — scale converts stored↔shown (ratios).
const NUMBERS = {
  hotGates: [
    ['hotMaxTop10', 'Max top-10 holders', 0, 100, '%'],
    ['hotMaxDev', 'Max dev holdings', 0, 100, '%'],
    ['hotMaxSnipers', 'Max snipers', 0, 100, '%'],
    ['hotMaxBundlers', 'Max bundlers', 0, 100, '%'],
    ['hotMaxInsiders', 'Max insiders', 0, 100, '%'],
    ['hotMinHolders', 'Min holders', 0, 100000, ''],
    ['hotMinProRatio', 'Min pro-trader share', 0, 100, '%', 100],
    ['hotMaxProRatio', 'Max pro-trader share', 0, 100, '%', 100],
    ['hotMinUtilityScore', 'Min utility score', 0, 20, '']
  ],
  scoreFields: [
    ['minScore', 'Hide below score', -10, 10, ''],
    ['gemMinScore', 'Flag 💎 gem at score ≥', 1, 20, '']
  ],
  tpFields: [
    ['thresholdPct', 'Remind when up', 1, 1000, '%'],
    ['snoozeMin', 'Snooze length', 1, 240, 'min'],
    ['refireStepPct', 'Re-nag after climb of', 1, 500, 'pts'],
    ['stopLossPct', 'Stop-loss at down', 1, 100, '%'],
    ['peakGivebackPct', 'Peak-giveback after', 1, 500, 'pts']
  ],
  creatorFields: [
    ['creatorMaxLaunches', 'Flag creator after N launches', 1, 100, ''],
    ['creatorMaxRugs', '…or after N rugs', 1, 50, '']
  ],
  tokenPageFields: [
    ['scalpMaxSellTaxPct', 'Flag exit blocked over sell tax', 1, 90, '%']
  ],
  fomoFields: [
    ['dailyLossLimit', 'Stop-for-today after N losses', 1, 50, ''],
    ['revengeWindowMin', 'Revenge window', 1, 1440, 'min'],
    ['revengeToastSec', 'Revenge toast duration', 3, 60, 'sec']
  ],
  dumpFields: [
    ['whaleSellUsd', 'Whale sell alert over $', 1, 1000000, ''],
    ['whaleSellLiquidityPct', '…or % of liquidity', 0, 100, '%'],
    ['dumpWindowMin', 'Only sells within', 1, 60, 'min'],
    ['exitAlarmDropPct', 'Exit alarm on 5m drop of', 1, 90, '%']
  ]
};

const $ = (id) => document.getElementById(id);
let toastTimer = null;
const flash = () => {
  const el = $('status');
  el.textContent = 'Saved';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1100);
};

const loadSettings = async () => {
  const res = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(res.settings || {}) };
};
const saveSettings = async (patch) => {
  const current = await loadSettings();
  await chrome.storage.local.set({ settings: { ...current, ...patch } });
  flash();
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const renderToggle = (key, label, sub, settings) => {
  const row = el('div', 'row');
  const labelWrap = el('span', 'label');
  labelWrap.append(document.createTextNode(label));
  if (sub) labelWrap.append(el('span', 'sub', sub));

  const toggle = el('label', 'toggle');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = Boolean(settings[key]);
  input.addEventListener('change', () => saveSettings({ [key]: input.checked }));
  toggle.append(input, el('span', 'box'));

  row.append(labelWrap, toggle);
  return row;
};

const renderNumber = ([key, label, min, max, unit, scale], settings) => {
  const row = el('div', 'row numrow');
  row.append(el('span', 'label', label));
  const field = el('span', 'field');
  const input = el('input');
  input.type = 'number';
  input.min = String(scale ? min : min);
  input.max = String(max);
  input.value = String(scale ? Math.round(settings[key] * scale) : settings[key]);
  input.addEventListener('change', () => {
    const shown = Number(input.value);
    if (!Number.isFinite(shown) || shown < min || shown > max) {
      input.value = String(scale ? Math.round(settings[key] * scale) : settings[key]);
      return;
    }
    saveSettings({ [key]: scale ? shown / scale : shown });
    settings[key] = scale ? shown / scale : shown;
  });
  field.append(input);
  if (unit) field.append(el('span', 'unit', unit));
  row.append(field);
  return row;
};

const renderHideRules = (settings) => {
  const wrap = $('hideRules');
  wrap.innerHTML = '';
  for (const m of HIDE_METRICS) {
    const onKey = `hide_${m.key}_on`;
    const maxKey = `hide_${m.key}_max`;
    const row = el('div', 'row numrow');

    const left = el('span', 'label');
    const toggle = el('label', 'toggle');
    toggle.style.marginRight = '8px';
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = Boolean(settings[onKey]);
    cb.addEventListener('change', () => saveSettings({ [onKey]: cb.checked }));
    toggle.append(cb, el('span', 'box'));
    left.style.display = 'flex';
    left.style.alignItems = 'center';
    left.append(toggle, document.createTextNode(m.label));

    const field = el('span', 'field');
    const num = el('input');
    num.type = 'number';
    num.min = '1'; num.max = '100';
    num.value = String(settings[maxKey]);
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (v >= 1 && v <= 100) { saveSettings({ [maxKey]: v }); settings[maxKey] = v; }
      else num.value = String(settings[maxKey]);
    });
    field.append(num, el('span', 'unit', '%'));
    row.append(left, field);
    wrap.appendChild(row);
  }
};

const renderBadges = (settings) => {
  const wrap = $('badges');
  wrap.innerHTML = '';
  for (const badge of KNOWN_BADGES) {
    const label = el('label', settings.memeBadges.includes(badge) ? 'on' : '', badge);
    label.addEventListener('click', async () => {
      const cur = await loadSettings();
      const memeBadges = cur.memeBadges.includes(badge)
        ? cur.memeBadges.filter((b) => b !== badge)
        : [...cur.memeBadges, badge];
      await saveSettings({ memeBadges });
      renderBadges(await loadSettings());
    });
    wrap.appendChild(label);
  }
};

const renderOverrides = async () => {
  const res = await chrome.storage.local.get('overrides');
  const overrides = res.overrides || {};
  const wrap = $('overrides');
  wrap.innerHTML = '';
  const entries = Object.entries(overrides);
  if (!entries.length) { wrap.append(el('div', 'hint', 'None yet.')); return; }
  for (const [addr, mode] of entries) {
    const row = el('div', 'ov-row');
    row.append(el('span', null, `${mode === 'hide' ? '⊘' : '✓'} ${addr.slice(0, 10)}…`));
    const del = el('button', null, 'remove');
    del.addEventListener('click', async () => {
      const { [addr]: _gone, ...rest } = overrides;
      await chrome.storage.local.set({ overrides: rest });
      renderOverrides();
    });
    row.append(del);
    wrap.appendChild(row);
  }
};

// Standalone journal summary (popup is dependency-free; mirror of
// BBD.journal.summarize). Only trades with a fresh, numeric exit count toward
// win rate / averages — stale-exit closes are surfaced separately, not trusted.
const summarizeJournal = (journal) => {
  const all = Object.values(journal || {});
  const closed = all.filter((e) => e.status === 'closed' && typeof e.exitPct === 'number');
  const n = closed.length;
  const wins = closed.filter((e) => e.exitPct > 0).length;
  const gb = closed.filter((e) => typeof e.peakPct === 'number' && e.peakPct > 0)
    .map((e) => e.peakPct - e.exitPct);
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  return {
    openCount: all.filter((e) => e.status === 'open').length,
    closedCount: n,
    winRate: n ? Math.round((100 * wins) / n) : 0,
    avgExitPct: Math.round(mean(closed.map((e) => e.exitPct))),
    avgGiveBackPct: Math.round(mean(gb)),
    unknownExitCount: all.filter((e) => e.status === 'closed' && typeof e.exitPct !== 'number').length
  };
};

const renderJournal = (journal) => {
  const s = summarizeJournal(journal);
  const wrap = $('journalSummary');
  wrap.innerHTML = '';
  const line = (label, value, strong) => {
    const row = el('div', 'row numrow');
    row.append(el('span', 'label', label), el('span', strong ? 'field strong' : 'field', value));
    wrap.appendChild(row);
  };
  if (!s.closedCount && !s.openCount) { wrap.append(el('div', 'hint', 'No trades logged yet.')); return; }
  line('Closed trades', `${s.closedCount}${s.openCount ? ` (+${s.openCount} open)` : ''}`);
  line('Win rate', `${s.winRate}%`);
  line('Avg tracked exit', `${s.avgExitPct >= 0 ? '+' : ''}${s.avgExitPct}%`);
  // The flagship discipline metric: profit ridden past the exit.
  line('Avg profit given back', `${s.avgGiveBackPct}%`, true);
  if (s.unknownExitCount) line('Closed without fresh exit', String(s.unknownExitCount));
};

const CALIBRATION_LEVELS = ['low', 'medium', 'high', 'critical'];

const calibrationHeadline = (report) => {
  if (!report.ready) return `Not enough data yet — ${report.readyReason}.`;
  if (report.trend === 'expected') {
    return 'Higher risk tracked higher loss rate — preliminary.';
  }
  if (report.trend === 'inverted') {
    return 'Warning: higher risk tracked a lower loss rate — preliminary inversion.';
  }
  return 'Warning: risk levels showed a mixed loss-rate pattern — preliminary.';
};

const renderCalibration = (journal) => {
  const report = BBD.calibration.analyze(journal, { now: Date.now() });
  const wrap = $('advisorCalibration');
  wrap.replaceChildren();

  wrap.append(el('div',
    `calibration-headline ${report.ready ? 'ready' : 'not-ready'}`,
    calibrationHeadline(report)));

  for (const level of CALIBRATION_LEVELS) {
    const stats = report.levels[level];
    if (!stats) continue;
    const row = el('div', 'calibration-row');
    row.append(
      el('span', 'calibration-level',
        `Risk: ${level} — n=${stats.n}, loss ${stats.lossRatePct}%, avg ${stats.avgExitPct}%`),
      el('span', `calibration-grade ${stats.grade}`, stats.grade)
    );
    wrap.append(row);
  }

  wrap.append(
    el('div', 'hint',
      `${report.confounding.possiblyActedOn} trades closed within ` +
      `${report.confounding.windowMin} min of a high/critical warning — ` +
      'may reflect you acting on it, not the model being wrong.'),
    el('div', 'hint', 'Earliest verdict per trade; exits are fresh PnL estimates.')
  );
};

const renderHealth = async () => {
  const { positions = {}, positionsMeta = {} } = await chrome.storage.local.get(['positions', 'positionsMeta']);
  const wrap = $('health');
  wrap.innerHTML = '';
  const line = (label, value) => {
    const row = el('div', 'row numrow');
    row.append(el('span', 'label', label), el('span', 'field', value));
    wrap.appendChild(row);
  };
  const ageMs = typeof positionsMeta.sourceTs === 'number' ? Date.now() - positionsMeta.sourceTs : null;
  const age = ageMs === null ? 'waiting…' : ageMs < 5000 ? 'just now'
    : ageMs < 60000 ? `${Math.round(ageMs / 1000)}s ago` : `${Math.round(ageMs / 60000)}m ago`;
  line('Positions tracked', String(Object.keys(positions).length));
  line('Source', positionsMeta.source === 'balances-api' ? 'BasedBot balances API'
    : positionsMeta.source === 'dom-fallback' ? 'Visible page fallback' : 'Not connected yet');
  line('Last update', age);
};

const init = async () => {
  const settings = await loadSettings();
  try { $('plate').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) { /* */ }

  for (const [mount, list] of Object.entries(TOGGLES)) {
    const box = $(mount);
    list.forEach(([k, label, sub]) => box.append(renderToggle(k, label, sub, settings)));
  }
  for (const [mount, list] of Object.entries(NUMBERS)) {
    const box = $(mount);
    list.forEach((spec) => box.append(renderNumber(spec, settings)));
  }

  $('maxTaxPct').value = String(settings.maxTaxPct);
  $('maxTaxPct').addEventListener('change', () => {
    const v = Number($('maxTaxPct').value);
    if (v >= 0 && v <= 100) saveSettings({ maxTaxPct: v });
    else $('maxTaxPct').value = String(settings.maxTaxPct);
  });

  for (const id of ['tgToken', 'tgChatId']) {
    $(id).value = settings[id] || '';
    $(id).addEventListener('change', () => saveSettings({ [id]: $(id).value.trim() }));
  }

  const providerSelect = $('advisorProvider');
  providerSelect.append(el('option', null, 'Choose provider…'));
  providerSelect.firstChild.value = '';
  for (const preset of BBD.provider.PRESETS) {
    const option = el('option', null, preset.label);
    option.value = preset.id;
    providerSelect.append(option);
  }
  providerSelect.value = settings.advisorProvider || '';

  for (const id of ['advisorBaseUrl', 'advisorModel', 'advisorApiKey']) {
    $(id).value = settings[id] || '';
    $(id).addEventListener('change', () => saveSettings({ [id]: $(id).value.trim() }));
  }

  $('advisorMaxTokens').value = String(settings.advisorMaxTokens || DEFAULTS.advisorMaxTokens);
  $('advisorMaxTokens').addEventListener('change', () => {
    const v = Math.round(Number($('advisorMaxTokens').value));
    if (Number.isInteger(v) && v >= 256 && v <= 32000) saveSettings({ advisorMaxTokens: v });
    else $('advisorMaxTokens').value = String(settings.advisorMaxTokens || DEFAULTS.advisorMaxTokens);
  });

  $('advisorHorizonMin').value =
    String(settings.advisorHorizonMin || DEFAULTS.advisorHorizonMin);
  $('advisorHorizonMin').addEventListener('change', () => {
    const v = Math.round(Number($('advisorHorizonMin').value));
    if (Number.isInteger(v) && v >= 1 && v <= 240) saveSettings({ advisorHorizonMin: v });
    else {
      $('advisorHorizonMin').value =
        String(settings.advisorHorizonMin || DEFAULTS.advisorHorizonMin);
    }
  });

  providerSelect.addEventListener('change', async () => {
    const preset = BBD.provider.PRESETS.find((item) => item.id === providerSelect.value);
    $('advisorBaseUrl').value = preset ? preset.baseUrl : '';
    $('advisorModel').value = preset ? preset.defaultModel : '';
    // Thinking-disable follows the preset: on for GLM's reasoning models, off
    // for the rest — leaving it on would make providers that reject an unknown
    // `thinking` field (e.g. OpenAI) 400. Re-render the toggles so the checkbox
    // reflects the change.
    const noThinking = !!(preset && preset.noThinking);
    await saveSettings({
      advisorProvider: providerSelect.value,
      advisorBaseUrl: $('advisorBaseUrl').value.trim(),
      advisorModel: $('advisorModel').value.trim(),
      advisorNoThinking: noThinking
    });
    const box = $('advisorToggles');
    box.replaceChildren();
    const fresh = await loadSettings();
    TOGGLES.advisorToggles.forEach(([k, label, sub]) => box.append(renderToggle(k, label, sub, fresh)));
  });

  const setAdvisorStatus = (text) => {
    $('advisorStatus').textContent = text;
  };
  $('testAdvisor').addEventListener('click', async () => {
    let parsedUrl;
    try {
      parsedUrl = new URL($('advisorBaseUrl').value.trim());
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('bad protocol');
    } catch (err) {
      setAdvisorStatus('Enter a valid HTTP(S) base URL.');
      return;
    }

    const pattern = `${parsedUrl.origin}/*`;
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [pattern] });
    } catch (err) {
      setAdvisorStatus('Could not request access to that provider origin.');
      return;
    }
    if (!granted) {
      setAdvisorStatus('Provider access was denied; no test was sent.');
      return;
    }

    await saveSettings({
      advisorProvider: providerSelect.value,
      advisorBaseUrl: $('advisorBaseUrl').value.trim(),
      advisorModel: $('advisorModel').value.trim(),
      advisorApiKey: $('advisorApiKey').value.trim()
    });
    setAdvisorStatus('Testing provider…');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'bbd-advisor-test' });
      setAdvisorStatus(result && result.ok
        ? 'Provider connection works.'
        : (result && result.reason) || 'Provider test failed.');
    } catch (err) {
      setAdvisorStatus('Provider test failed.');
    }
  });

  $('memeKeywords').value = settings.memeKeywords.join(', ');
  $('memeKeywords').addEventListener('change', () => {
    const memeKeywords = $('memeKeywords').value.split(',')
      .map((s) => s.trim().toLowerCase()).filter(Boolean);
    saveSettings({ memeKeywords });
  });

  renderHideRules(settings);
  renderBadges(settings);
  renderOverrides();
  const { journal = {} } = await chrome.storage.local.get('journal');
  renderJournal(journal);
  renderCalibration(journal);
  renderHealth();

  $('exportJournal').addEventListener('click', async () => {
    const { journal = {} } = await chrome.storage.local.get('journal');
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), journal }, null, 2)],
      { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = `basedbot-journal-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('clearJournal').addEventListener('click', async () => {
    if (!confirm('Delete the local trade journal? Export it first if you may need it.')) return;
    await chrome.storage.local.set({ journal: {} });
    renderJournal({});
    renderCalibration({});
  });
};

init().catch((err) => {
  const s = $('status'); if (s) { s.textContent = 'Load failed'; s.classList.add('show'); }
  console.error('[bbd] popup init failed', err);
});
