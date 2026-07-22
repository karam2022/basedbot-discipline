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
  hotEnabled: true,
  laptopHotAlerts: true,
  creatorGuardEnabled: true,
  creatorMaxLaunches: 5,
  creatorMaxRugs: 2,
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

  for (const id of ['filterEnabled', 'hotEnabled', 'laptopHotAlerts', 'creatorGuardEnabled', 'reminderEnabled', 'notifyEnabled']) {
    $(id).checked = Boolean(settings[id]);
    $(id).addEventListener('change', () => saveSettings({ [id]: $(id).checked }));
  }
  for (const id of ['thresholdPct', 'snoozeMin', 'minScore', 'gemMinScore', 'creatorMaxLaunches', 'creatorMaxRugs']) {
    $(id).value = settings[id];
    $(id).addEventListener('change', () => {
      const value = Number($(id).value);
      // These floor at 1; the rest may go to/through zero (or negative, minScore).
      const mustBePositive = ['thresholdPct', 'snoozeMin', 'creatorMaxLaunches', 'creatorMaxRugs'].includes(id);
      // gemMinScore floor: 0 would mark every visible token a gem (#7).
      if (id === 'gemMinScore' && value < 1) return;
      if (Number.isFinite(value) && (!mustBePositive || value > 0)) {
        saveSettings({ [id]: value });
      }
    });
  }
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
