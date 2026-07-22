// Popup settings UI. Reads/writes chrome.storage.local; content scripts react
// via storage.onChanged.
'use strict';

const DEFAULTS = {
  filterEnabled: true,
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
  hotEnabled: true,
  laptopHotAlerts: true,
  tgToken: '',
  tgChatId: '',
  memeBadges: ['Pons', 'bow.fun', 'Flap', 'Circus', 'Charms', 'Long.xyz', 'Bankr', 'Ape Store',
    'Zora', 'Clanker', 'Flaunch', 'Stroid', 'Klik', 'Trench', 'Livo',
    'Pump.fun', 'PumpFun', 'PumpSwap', 'Bags', 'Meteora DBC'],
  memeKeywords: [
    'pepe', 'inu', 'doge', 'shib', 'wif', 'bonk', 'elon', 'trump', 'moon',
    'wojak', 'chad', 'frog', 'cat', 'dog', 'kitty', 'pup', 'baby', 'fart',
    'butt', 'cum', 'tendies', 'rug', 'ape', 'monke', 'gigachad', 'meme'
  ]
};

const KNOWN_BADGES = [
  'Pons', 'Virtual', 'bow.fun', 'Flap', 'Circus', 'Charms', 'Bankr', 'Long.xyz',
  'Ape Store', 'Zora', 'Clanker', 'Flaunch', 'Stroid', 'Klik', 'Trench', 'Livo',
  'Pump.fun', 'PumpSwap', 'Bags', 'Meteora DBC'
];

const $ = (id) => document.getElementById(id);
const flash = (text) => {
  $('status').textContent = text;
  setTimeout(() => { $('status').textContent = ''; }, 1500);
};

const loadSettings = async () => {
  const res = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(res.settings || {}) };
};

const saveSettings = async (patch) => {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  flash('Saved');
  return next;
};

// One row per hide metric (from BBD.HIDE_METRICS if present, else a static
// mirror so the popup works standalone): [x] Label [max] %.
const HIDE_METRICS = (self.BBD && BBD.HIDE_METRICS) || [
  { key: 'top10', label: 'Top-10 holders own >' },
  { key: 'insiders', label: 'Insiders own >' },
  { key: 'bundlers', label: 'Bundlers own >' },
  { key: 'snipers', label: 'Snipers own >' },
  { key: 'dev', label: 'Dev holds >' }
];

const renderHideRules = (settings) => {
  const wrap = $('hideRules');
  wrap.innerHTML = '';
  for (const m of HIDE_METRICS) {
    const onKey = `hide_${m.key}_on`;
    const maxKey = `hide_${m.key}_max`;
    const row = document.createElement('label');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '6px';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = Boolean(settings[onKey]);
    cb.addEventListener('change', () => saveSettings({ [onKey]: cb.checked }));

    const txt = document.createElement('span');
    txt.textContent = m.label;

    const num = document.createElement('input');
    num.type = 'number';
    num.min = '1';
    num.max = '100';
    num.style.width = '52px';
    num.value = settings[maxKey];
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (v >= 1 && v <= 100) saveSettings({ [maxKey]: v });
    });

    const pct = document.createElement('span');
    pct.textContent = '%';
    row.append(cb, txt, num, pct);
    wrap.appendChild(row);
  }
};

const renderBadges = (settings) => {
  const wrap = $('badges');
  wrap.innerHTML = '';
  for (const badge of KNOWN_BADGES) {
    const label = document.createElement('label');
    const on = settings.memeBadges.includes(badge);
    label.className = on ? 'on' : '';
    label.textContent = (on ? '🚫 ' : '') + badge;
    label.addEventListener('click', async () => {
      const cur = await loadSettings();
      const memeBadges = cur.memeBadges.includes(badge)
        ? cur.memeBadges.filter((b) => b !== badge)
        : [...cur.memeBadges, badge];
      renderBadges(await saveSettings({ memeBadges }));
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
  if (entries.length === 0) {
    wrap.innerHTML = '<span class="hint">None yet.</span>';
    return;
  }
  for (const [addr, mode] of entries) {
    const row = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = `${mode === 'hide' ? '🚫' : '✓'} ${addr.slice(0, 10)}…`;
    const del = document.createElement('button');
    del.textContent = 'remove';
    del.addEventListener('click', async () => {
      const { [addr]: _gone, ...rest } = overrides;
      await chrome.storage.local.set({ overrides: rest });
      renderOverrides();
    });
    row.append(label, del);
    wrap.appendChild(row);
  }
};

const init = async () => {
  const settings = await loadSettings();

  for (const id of ['filterEnabled', 'hideByTopHolder', 'hotEnabled', 'laptopHotAlerts', 'reminderEnabled', 'notifyEnabled']) {
    $(id).checked = Boolean(settings[id]);
    $(id).addEventListener('change', () => saveSettings({ [id]: $(id).checked }));
  }
  for (const id of ['thresholdPct', 'snoozeMin', 'minScore', 'gemMinScore', 'maxTaxPct']) {
    $(id).value = settings[id];
    $(id).addEventListener('change', () => {
      const value = Number($(id).value);
      const mustBePositive = id === 'thresholdPct' || id === 'snoozeMin';
      // gemMinScore floor: 0 would mark every visible token a gem (#7).
      if (id === 'gemMinScore' && value < 1) return;
      if (id === 'maxTaxPct' && !(value >= 0 && value <= 100)) return;
      if (Number.isFinite(value) && (!mustBePositive || value > 0)) {
        saveSettings({ [id]: value });
      }
    });
  }
  renderHideRules(settings);
  for (const id of ['tgToken', 'tgChatId']) {
    $(id).value = settings[id] || '';
    $(id).addEventListener('change', () => saveSettings({ [id]: $(id).value.trim() }));
  }
  $('memeKeywords').value = settings.memeKeywords.join(', ');
  $('memeKeywords').addEventListener('change', () => {
    const memeKeywords = $('memeKeywords').value
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    saveSettings({ memeKeywords });
  });

  renderBadges(settings);
  renderOverrides();
};

init().catch((err) => {
  $('status').textContent = 'Failed to load settings';
  console.error('[bbd] popup init failed', err);
});
