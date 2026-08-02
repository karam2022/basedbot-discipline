// The Paperwork — per-position dismount plans, filed BEFORE the ride.
// When a held position has no plan, a small card asks for its take-profit and
// stop. Whatever is filed becomes THAT token's banner thresholds (banner.js
// reads BBD.KEYS.plans); Skip files an explicit "use the global defaults" so
// the card never nags twice. "The rider filed it before the run."
'use strict';

BBD.plans = (() => {
  const CARD_ID = 'bbd-plan-card';
  const MAX_ROWS = 2;

  const remove = () => {
    const el = document.getElementById(CARD_ID);
    if (el) el.remove();
  };

  const numOr = (v, fb) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= 1000 ? n : fb;
  };

  // The ⚡ plan: tracked best-practice numbers, editable in the popup.
  const fileAuto = (positionKey, settings) =>
    BBD.store.mergeEntry(BBD.KEYS.plans, positionKey, {
      tpPct: settings.autoPlanTpPct,
      stopPct: settings.autoPlanStopPct,
      auto: true,
      ts: Date.now()
    });

  const renderRow = (pos, settings) => {
    const row = document.createElement('div');
    row.className = 'bbd-plan-row';

    const sym = document.createElement('span');
    sym.className = 'bbd-plan-sym';
    sym.textContent = BBD.sanitizeAlertText(pos.symbol, 12) || pos.addr.slice(0, 8);

    const mkInput = (value, label) => {
      const wrap = document.createElement('label');
      wrap.className = 'bbd-plan-field';
      const span = document.createElement('span');
      span.textContent = label;
      const input = document.createElement('input');
      input.type = 'number';
      input.value = String(value);
      input.min = '1';
      input.max = '1000';
      wrap.append(span, input);
      return { wrap, input };
    };
    const tp = mkInput(settings.thresholdPct, 'TP +%');
    const stop = mkInput(settings.stopLossPct, 'stop −%');

    // ⚡ one-click best-practice plan: +30 came from tracked trades (every one
    // that touched +30% finished green); the numbers are editable in the popup.
    const auto = document.createElement('button');
    auto.type = 'button';
    auto.className = 'bbd-plan-auto';
    auto.textContent = `⚡ +${settings.autoPlanTpPct}/−${settings.autoPlanStopPct}`;
    auto.title = 'File the auto plan for this position — one click, done';
    auto.addEventListener('click', async () => {
      await fileAuto(pos.positionKey, settings);
      BBD.plans.tick();
      BBD.banner.tick();
    });

    const file = document.createElement('button');
    file.type = 'button';
    file.className = 'bbd-plan-file';
    file.textContent = 'File';
    file.addEventListener('click', async () => {
      await BBD.store.mergeEntry(BBD.KEYS.plans, pos.positionKey, {
        tpPct: numOr(tp.input.value, settings.thresholdPct),
        stopPct: numOr(stop.input.value, settings.stopLossPct),
        ts: Date.now()
      });
      BBD.plans.tick();
      BBD.banner.tick();
    });

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'bbd-plan-skip';
    skip.textContent = 'defaults';
    skip.title = `Use the global thresholds (+${settings.thresholdPct}/−${settings.stopLossPct}) for this one`;
    skip.addEventListener('click', async () => {
      await BBD.store.mergeEntry(BBD.KEYS.plans, pos.positionKey, { skipped: true, ts: Date.now() });
      BBD.plans.tick();
    });

    row.append(sym, tp.wrap, stop.wrap, file, skip);
    return row;
  };

  const render = (unplanned, settings) => {
    remove();
    const card = document.createElement('div');
    card.id = CARD_ID;
    const head = document.createElement('div');
    head.className = 'bbd-plan-head';
    const headText = document.createElement('span');
    headText.textContent = '✍️ New position — write your dismount before the ride';
    head.append(headText);
    if (unplanned.length > 1) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'bbd-plan-auto';
      all.textContent = `⚡ file all ${unplanned.length}`;
      all.title = `Auto plan (+${settings.autoPlanTpPct}/−${settings.autoPlanStopPct}) for every unplanned position`;
      all.addEventListener('click', async () => {
        for (const p of unplanned) await fileAuto(p.positionKey, settings);
        BBD.plans.tick();
        BBD.banner.tick();
      });
      head.append(all);
    }
    card.append(head);
    unplanned.slice(0, MAX_ROWS).forEach((p) => card.append(renderRow(p, settings)));
    if (unplanned.length > MAX_ROWS) {
      const more = document.createElement('div');
      more.className = 'bbd-plan-more';
      more.textContent = `…and ${unplanned.length - MAX_ROWS} more unplanned`;
      card.append(more);
    }
    document.body.appendChild(card);
  };

  const tick = async () => {
    try {
      const settings = await BBD.store.settings();
      if (!settings.planPromptEnabled) { remove(); return; }
      const [positions, plans] = await Promise.all([
        BBD.store.get(BBD.KEYS.positions, {}),
        BBD.store.get(BBD.KEYS.plans, {})
      ]);
      // prune plans whose position is gone — a re-entry files fresh paperwork
      const stale = Object.keys(plans).filter((k) => !positions[k]);
      if (stale.length) {
        const next = { ...plans };
        stale.forEach((k) => delete next[k]);
        await BBD.store.set(BBD.KEYS.plans, next);
      }
      const unplanned = Object.values(positions)
        .filter((p) => typeof p.pct === 'number' && !plans[p.positionKey])
        .filter((p) => typeof p.sourceTs === 'number' && Date.now() - p.sourceTs <= BBD.STALE_MS);
      if (!unplanned.length) { remove(); return; }
      // Zero-click mode for 20-buys-a-day sessions: every new position gets the
      // ⚡ plan filed automatically, no card shown.
      if (settings.autoPlanAll) {
        for (const p of unplanned) await fileAuto(p.positionKey, settings);
        remove();
        BBD.banner.tick();
        return;
      }
      render(unplanned, settings);
    } catch (err) {
      console.warn('[bbd] plans tick failed', err);
    }
  };

  return { tick };
})();
