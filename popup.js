// Popup settings UI. Reads/writes chrome.storage.local; content scripts react
// via storage.onChanged.
'use strict';

// Single source of truth: constants.js (loaded before this script) provides
// BBD.DEFAULT_SETTINGS and BBD.KNOWN_BADGES — no more hand-mirrored copies here.
// Only the popup-only Telegram credentials are layered on top.
const DEFAULTS = { ...BBD.DEFAULT_SETTINGS, tgToken: '', tgChatId: '' };
const KNOWN_BADGES = BBD.KNOWN_BADGES;

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

// Standalone journal summary (popup has no access to the content-script BBD
// namespace; keep this in sync with BBD.journal.summarize).
const summarizeJournal = (journal) => {
  const all = Object.values(journal || {});
  const closed = all.filter((e) => e.status === 'closed' && typeof e.exitPct === 'number');
  const n = closed.length;
  const wins = closed.filter((e) => e.exitPct > 0).length;
  const gb = closed.filter((e) => typeof e.peakPct === 'number' && e.peakPct > 0)
    .map((e) => e.peakPct - e.exitPct);
  const flagged = closed.filter((e) => e.entryVerdict && e.entryVerdict.devFlagged);
  const flaggedLosses = flagged.filter((e) => e.exitPct <= 0).length;
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    openCount: all.filter((e) => e.status === 'open').length,
    closedCount: n,
    winRate: n ? Math.round((100 * wins) / n) : 0,
    avgExitPct: Math.round(mean(closed.map((e) => e.exitPct))),
    avgGiveBackPct: Math.round(mean(gb)),
    flaggedCount: flagged.length,
    flaggedLossRate: flagged.length ? Math.round((100 * flaggedLosses) / flagged.length) : 0
  };
};

const renderJournal = async () => {
  const res = await chrome.storage.local.get('journal');
  const s = summarizeJournal(res.journal || {});
  const wrap = $('journal');
  wrap.innerHTML = '';
  if (s.closedCount === 0) {
    wrap.innerHTML = `<span class="hint">No closed trades yet${s.openCount ? ` · ${s.openCount} open` : ''}.</span>`;
    return;
  }
  const line = (label, val) => {
    const row = document.createElement('div');
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('span');
    v.textContent = val;
    row.append(l, v);
    wrap.appendChild(row);
  };
  line('Closed trades', `${s.closedCount}${s.openCount ? ` (+${s.openCount} open)` : ''}`);
  line('Win rate', `${s.winRate}%`);
  line('Avg realized', `${s.avgExitPct >= 0 ? '+' : ''}${s.avgExitPct}%`);
  line('Avg profit given back', `${s.avgGiveBackPct}%`);
  if (s.flaggedCount) line('Flagged-dev buys', `${s.flaggedCount} · ${s.flaggedLossRate}% lost`);
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

  for (const id of ['filterEnabled', 'cardIntelEnabled', 'hotEnabled', 'auditGuardEnabled', 'laptopHotAlerts', 'creatorGuardEnabled', 'reminderEnabled', 'stopLossEnabled', 'journalEnabled', 'fomoGuardEnabled', 'dumpAlertsEnabled', 'notifyEnabled']) {
    $(id).checked = Boolean(settings[id]);
    $(id).addEventListener('change', () => saveSettings({ [id]: $(id).checked }));
  }
  for (const id of ['thresholdPct', 'snoozeMin', 'stopLossPct', 'minScore', 'gemMinScore', 'creatorMaxLaunches', 'creatorMaxRugs', 'dailyLossLimit', 'whaleSellUsd']) {
    $(id).value = settings[id];
    $(id).addEventListener('change', () => {
      const value = Number($(id).value);
      // These floor at 1; the rest may go to/through zero (or negative, minScore).
      const mustBePositive = ['thresholdPct', 'snoozeMin', 'stopLossPct', 'creatorMaxLaunches', 'creatorMaxRugs', 'dailyLossLimit', 'whaleSellUsd'].includes(id);
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

  const clearJournal = $('clearJournal');
  if (clearJournal) {
    clearJournal.addEventListener('click', async () => {
      await chrome.storage.local.set({ journal: {} });
      renderJournal();
      flash('Journal cleared');
    });
  }

  renderBadges(settings);
  renderOverrides();
  renderJournal();
};

init().catch((err) => {
  $('status').textContent = 'Failed to load settings';
  console.error('[bbd] popup init failed', err);
});
