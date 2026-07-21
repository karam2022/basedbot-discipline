// Entry point: wires the filter, PnL watcher and banner to the SPA lifecycle.
'use strict';

(() => {
  let scanQueued = false;
  let lastPath = null;
  const intervals = [];

  // After an extension reload this script is an orphan: every chrome.* call
  // throws. Tear everything down instead of erroring every tick forever.
  const shutdown = () => {
    intervals.forEach(clearInterval);
    observer.disconnect();
    ['bbd-filter-chip', 'bbd-banner', 'bbd-refresh', 'bbd-intel']
      .forEach((id) => document.getElementById(id)?.remove());
    document.querySelectorAll('.bbd-hidden, .bbd-gem, .bbd-hot, .bbd-override')
      .forEach((el) => {
        if (el.classList.contains('bbd-override')) el.remove();
        else el.classList.remove('bbd-hidden', 'bbd-gem', 'bbd-hot');
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

  // Throttled rescans while the live feed mutates. The feed mutates
  // continuously (price ticks), so a debounce that resets per mutation would
  // never fire — instead guarantee one trailing scan per throttle window.
  const observer = new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(guard(() => {
      scanQueued = false;
      BBD.filter.scan();
    }), BBD.SCAN_DEBOUNCE_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // SPA route changes have no navigation event we can rely on: poll the path.
  intervals.push(setInterval(guard(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      runForRoute();
    }
  }), BBD.ROUTE_POLL_MS));

  // Regular PnL + intel + banner refresh.
  intervals.push(setInterval(guard(() => {
    ensureRefreshBtn();
    BBD.pnl.scan();
    BBD.intel.scan();
    BBD.banner.tick();
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

  lastPath = location.pathname;
  ensureRefreshBtn();
  runForRoute();
})();
