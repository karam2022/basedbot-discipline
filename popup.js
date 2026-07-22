// Popup settings UI. Reads/writes chrome.storage.local; content scripts react
// via storage.onChanged.
'use strict';

// Single source of truth: constants.js (loaded before this script) provides
// BBD.DEFAULT_SETTINGS and BBD.KNOWN_BADGES — no more hand-mirrored copies here.
// Only the popup-only Telegram credentials are layered on top.
const DEFAULTS = { ...BBD.DEFAULT_SETTINGS, tgToken: '', tgChatId: '' };
const KNOWN_BADGES = BBD.KNOWN_BADGES;

const $ = (id) => document.getElementById(id);
const flash = (text, error = false) => {
  $('status').classList.toggle('error', error);
  $('status').textContent = text;
  setTimeout(() => {
    $('status').textContent = '';
    $('status').classList.remove('error');
  }, error ? 3500 : 1800);
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
  const closed = all.filter((e) => e.status === 'closed' && e.tradeId && typeof e.exitPct === 'number');
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
    flaggedLossRate: flagged.length ? Math.round((100 * flaggedLosses) / flagged.length) : 0,
    unknownExitCount: all.filter((e) => e.status === 'closed' &&
      (!e.tradeId || typeof e.exitPct !== 'number')).length
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
  line('Avg tracked exit', `${s.avgExitPct >= 0 ? '+' : ''}${s.avgExitPct}%`);
  line('Avg profit given back', `${s.avgGiveBackPct}%`);
  if (s.unknownExitCount) line('Closed without fresh exit', `${s.unknownExitCount}`);
  if (s.flaggedCount) line('Flagged-dev buys', `${s.flaggedCount} · ${s.flaggedLossRate}% lost`);
};

const renderHealth = async () => {
  const res = await chrome.storage.local.get(['positions', 'positionsMeta']);
  const positions = res.positions || {};
  const meta = res.positionsMeta || {};
  const wrap = $('health');
  wrap.innerHTML = '';
  const line = (label, value) => {
    const row = document.createElement('div');
    const l = document.createElement('span');
    const v = document.createElement('span');
    l.textContent = label;
    v.textContent = value;
    row.append(l, v);
    wrap.appendChild(row);
  };
  const ageMs = typeof meta.sourceTs === 'number' ? Date.now() - meta.sourceTs : null;
  const age = ageMs === null ? 'waiting…' : ageMs < 5000 ? 'just now'
    : ageMs < 60000 ? `${Math.round(ageMs / 1000)}s ago`
      : `${Math.round(ageMs / 60000)}m ago`;
  line('Positions tracked', String(Object.keys(positions).length));
  const valued = Object.values(positions).filter((p) => typeof p.valueUsd === 'number' && p.valueUsd >= 0);
  const totalValue = valued.reduce((sum, p) => sum + p.valueUsd, 0);
  if (totalValue > 0) {
    const largest = Math.max(...valued.map((p) => p.valueUsd));
    line('Tracked position value', `$${totalValue.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
    line('Largest position share', `${Math.round(100 * largest / totalValue)}%`);
  }
  line('Source', meta.source === 'balances-api' ? 'BasedBot balances API'
    : meta.source === 'dom-fallback' ? 'Visible page fallback' : 'Not connected yet');
  line('Last source update', age);
  if (ageMs !== null && ageMs > BBD.STALE_MS) line('Status', '⚠️ stale — alerts paused');
  else if (ageMs !== null) line('Status', '✓ live');
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

  for (const id of ['filterEnabled', 'cardIntelEnabled', 'hotEnabled', 'auditGuardEnabled', 'laptopHotAlerts', 'creatorGuardEnabled', 'reminderEnabled', 'stopLossEnabled', 'peakGivebackEnabled', 'journalEnabled', 'fomoGuardEnabled', 'dumpAlertsEnabled', 'notifyEnabled']) {
    $(id).checked = Boolean(settings[id]);
    $(id).addEventListener('change', () => saveSettings({ [id]: $(id).checked }));
  }
  for (const id of ['thresholdPct', 'snoozeMin', 'stopLossPct', 'peakGivebackPct', 'minScore', 'gemMinScore', 'creatorMaxLaunches', 'creatorMaxRugs', 'dailyLossLimit', 'whaleSellUsd', 'whaleSellLiquidityPct']) {
    $(id).value = settings[id];
    $(id).addEventListener('change', () => {
      const value = Number($(id).value);
      // These floor at 1; the rest may go to/through zero (or negative, minScore).
      const mustBePositive = ['thresholdPct', 'snoozeMin', 'stopLossPct', 'peakGivebackPct', 'creatorMaxLaunches', 'creatorMaxRugs', 'dailyLossLimit', 'whaleSellUsd', 'whaleSellLiquidityPct'].includes(id);
      // gemMinScore floor: 0 would mark every visible token a gem (#7).
      if (id === 'gemMinScore' && value < 1) return;
      if (!$(id).checkValidity()) {
        flash('Value is outside the allowed range', true);
        $(id).value = settings[id];
      } else if (Number.isFinite(value) && (!mustBePositive || value > 0)) {
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
      if (!confirm('Delete the complete local trade journal? Export it first if you may need it.')) return;
      await chrome.storage.local.set({ journal: {} });
      renderJournal();
      flash('Journal cleared');
    });
  }

  $('exportJournal').addEventListener('click', async () => {
    const { journal = {} } = await chrome.storage.local.get('journal');
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), journal }, null, 2)],
      { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `basedbot-journal-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash('Journal exported');
  });

  $('toggleToken').addEventListener('click', () => {
    const input = $('tgToken');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    $('toggleToken').textContent = showing ? 'show' : 'hide';
    $('toggleToken').setAttribute('aria-label', showing ? 'Show bot token' : 'Hide bot token');
  });

  $('testTelegram').addEventListener('click', async () => {
    const btn = $('testTelegram');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await saveSettings({ tgToken: $('tgToken').value.trim(), tgChatId: $('tgChatId').value.trim() });
      const result = await chrome.runtime.sendMessage({ type: 'bbd-test-telegram' });
      if (result && result.ok) flash('Telegram test sent');
      else flash(result && result.reason || 'Telegram test failed', true);
    } catch (err) {
      flash(err.message || 'Telegram test failed', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send test alert';
    }
  });

  const applyPreset = async (patch, name) => {
    await saveSettings(patch);
    flash(`${name} preset applied`);
    setTimeout(() => location.reload(), 250);
  };
  $('presetConservative').addEventListener('click', () => applyPreset({
    thresholdPct: 15,
    stopLossPct: 15,
    peakGivebackPct: 10,
    dailyLossLimit: 2,
    whaleSellUsd: 200,
    whaleSellLiquidityPct: 1,
    minScore: 3,
    gemMinScore: 5,
    creatorMaxLaunches: 4,
    creatorMaxRugs: 1
  }, 'Conservative'));
  $('presetBalanced').addEventListener('click', () => applyPreset({
    thresholdPct: BBD.DEFAULT_SETTINGS.thresholdPct,
    stopLossPct: BBD.DEFAULT_SETTINGS.stopLossPct,
    peakGivebackPct: BBD.DEFAULT_SETTINGS.peakGivebackPct,
    dailyLossLimit: BBD.DEFAULT_SETTINGS.dailyLossLimit,
    whaleSellUsd: BBD.DEFAULT_SETTINGS.whaleSellUsd,
    whaleSellLiquidityPct: BBD.DEFAULT_SETTINGS.whaleSellLiquidityPct,
    minScore: BBD.DEFAULT_SETTINGS.minScore,
    gemMinScore: BBD.DEFAULT_SETTINGS.gemMinScore,
    creatorMaxLaunches: BBD.DEFAULT_SETTINGS.creatorMaxLaunches,
    creatorMaxRugs: BBD.DEFAULT_SETTINGS.creatorMaxRugs
  }, 'Balanced'));

  renderBadges(settings);
  renderOverrides();
  renderJournal();
  renderHealth();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.journal) renderJournal();
    if (changes.positions || changes.positionsMeta) renderHealth();
  });
};

init().catch((err) => {
  $('status').textContent = 'Failed to load settings';
  console.error('[bbd] popup init failed', err);
});
