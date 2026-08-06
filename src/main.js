// Entry point: wires the filter, PnL watcher and banner to the SPA lifecycle.
'use strict';

(() => {
  let scanQueued = false;
  let tickQueued = false;
  let lastPath = null;
  const intervals = [];

  // After an extension reload this script is an orphan: every chrome.* call
  // throws. Tear everything down instead of erroring every tick forever.
  const shutdown = () => {
    intervals.forEach(clearInterval);
    observer.disconnect();
    titleObserver.disconnect();
    ['bbd-filter-chip', 'bbd-banner', 'bbd-refresh', 'bbd-intel', 'bbd-fomo', 'bbd-guard-revenge']
      .forEach((id) => document.getElementById(id)?.remove());
    document.querySelectorAll('.bbd-hidden, .bbd-gem, .bbd-hot, .bbd-baddev, .bbd-danger, .bbd-override, .bbd-cardintel')
      .forEach((el) => {
        if (el.classList.contains('bbd-override') || el.classList.contains('bbd-cardintel')) el.remove();
        else el.classList.remove('bbd-hidden', 'bbd-gem', 'bbd-hot', 'bbd-baddev', 'bbd-danger');
      });
  };
  const guard = (fn) => () => {
    if (!BBD.alive()) {
      shutdown();
      return;
    }
    fn();
  };

  const runForRoute = () => {
    BBD.filter.scan();
    BBD.pnl.scan();
    BBD.intel.scan();
    BBD.banner.tick();
    BBD.plans.tick();
    BBD.guard.tick();
  };

  // Manual refresh button: forces a full re-scan on demand.
  const ensureRefreshBtn = () => {
    let btn = document.getElementById('bbd-refresh');
    if (btn && btn.isConnected) return;
    btn = document.createElement('button');
    btn.id = 'bbd-refresh';
    btn.type = 'button';
    btn.textContent = '↻';
    btn.title = 'BasedBot Discipline: re-scan now';
    btn.addEventListener('click', () => {
      btn.classList.add('bbd-spinning');
      setTimeout(() => btn.classList.remove('bbd-spinning'), 600);
      runForRoute();
    });
    document.body.appendChild(btn);
  };

  // The discipline tick: read positions first, THEN paint — so the banner
  // reacts to the value the page just rendered, not to the previous tick's.
  const lightTickRun = async () => {
    await BBD.pnl.scan();
    BBD.intel.scan();
    BBD.banner.tick();
    BBD.plans.tick();
    BBD.guard.tick();
  };

  // Event-driven discipline (idea from PaperTrench's title feed): the page
  // announces its own re-renders, so ride them with one trailing tick per
  // throttle window instead of a fixed poll. The flag stays up until the
  // async work settles, or two ticks interleave storage writes (same rule as
  // the filter path below).
  const queueLightTick = () => {
    if (tickQueued) return;
    tickQueued = true;
    setTimeout(guard(() => {
      lightTickRun().finally(() => {
        tickQueued = false;
      });
    }), BBD.LIGHT_TICK_MS);
  };

  // Throttled rescans while the live feed mutates. The feed mutates
  // continuously (price ticks), so a debounce that resets per mutation would
  // never fire — instead guarantee one trailing scan per throttle window.
  // scan() is async (storage reads): keep the flag up until it settles, or two
  // scans run in parallel and toggle classes against each other (same ticking
  // pattern as the VPS watcher).
  const observer = new MutationObserver(() => {
    queueLightTick();
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(guard(() => {
      Promise.resolve(BBD.filter.scan()).finally(() => {
        scanQueued = false;
      });
    }), BBD.SCAN_DEBOUNCE_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // The tab title is the cheapest change signal the site offers (symbol and
  // live numbers land there) — a title flip means state changed, with no DOM
  // traversal and no network. Observe it directly.
  const titleObserver = new MutationObserver(queueLightTick);
  const titleEl = document.querySelector('title');
  if (titleEl) titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });

  // SPA route changes have no navigation event we can rely on: poll the path.
  intervals.push(setInterval(guard(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      runForRoute();
    }
  }), BBD.ROUTE_POLL_MS));

  // Fallback poll — time-based state (snooze expiry, refire windows) advances
  // with no page mutation, and a quiet page must still get a periodic look.
  // Coalesces through the same queue as the event path.
  intervals.push(setInterval(guard(() => {
    ensureRefreshBtn();
    queueLightTick();
  }), BBD.POLL_MS));

  // React immediately when settings change from the popup.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes[BBD.KEYS.settings] || changes[BBD.KEYS.overrides])) {
        runForRoute();
      }
    });
  } catch (err) {
    console.warn('[bbd] storage listener failed', err);
  }

  // Storage housekeeping: at startup and hourly (#2).
  BBD.store.pruneAll();
  intervals.push(setInterval(guard(() => BBD.store.pruneAll()), 3600 * 1000));

  // Creator-reputation model lives in memory during a session; persist it on a
  // slow cadence and when the tab goes away so observations survive a reload.
  intervals.push(setInterval(guard(() => BBD.creator.flush()), 30 * 1000));
  window.addEventListener('pagehide', () => BBD.creator.flush());

  // Watch held positions' trade feeds for dev/whale dumps (#8). Slower cadence
  // than the DOM polls — these are real network calls, one per held token.
  intervals.push(setInterval(guard(() => BBD.dump.tick()), 20 * 1000));

  lastPath = location.pathname;
  ensureRefreshBtn();
  runForRoute();
})();
