// Thin immutable wrapper around chrome.storage.local.
'use strict';

BBD.store = {
  async get(key, fallback) {
    try {
      const res = await chrome.storage.local.get(key);
      return res[key] === undefined ? fallback : res[key];
    } catch (err) {
      // Orphaned scripts (post extension-reload) throw on every call — stay quiet.
      if (BBD.alive()) console.warn('[bbd] storage.get failed', key, err);
      return fallback;
    }
  },

  async set(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (err) {
      if (BBD.alive()) console.warn('[bbd] storage.set failed', key, err);
    }
  },

  async settings() {
    const saved = await this.get(BBD.KEYS.settings, {});
    return Object.freeze({ ...BBD.DEFAULT_SETTINGS, ...saved });
  },

  // Returns a NEW object with the entry merged in (immutability rule).
  async mergeEntry(key, entryKey, entryValue) {
    const current = await this.get(key, {});
    const next = { ...current, [entryKey]: entryValue };
    await this.set(key, next);
    return next;
  },

  async removeEntry(key, entryKey) {
    const current = await this.get(key, {});
    const { [entryKey]: _removed, ...next } = current;
    await this.set(key, next);
    return next;
  },

  // Drop entries older than maxAgeMs (timestamp via tsOf) and cap the map at
  // maxEntries (oldest evicted first). Every map key grows forever otherwise
  // and chrome.storage quota failure is silent (#2).
  async pruneMap(key, { maxAgeMs, maxEntries = 500, tsOf = (v) => v && v.ts }) {
    const current = await this.get(key, {});
    const now = Date.now();
    let entries = Object.entries(current).filter(([, v]) => {
      const ts = typeof v === 'number' ? v : tsOf(v);
      return typeof ts === 'number' ? now - ts < maxAgeMs : true;
    });
    if (entries.length > maxEntries) {
      entries = entries
        .sort((a, b) => {
          const ta = typeof a[1] === 'number' ? a[1] : tsOf(a[1]) || 0;
          const tb = typeof b[1] === 'number' ? b[1] : tsOf(b[1]) || 0;
          return tb - ta;
        })
        .slice(0, maxEntries);
    }
    if (entries.length !== Object.keys(current).length) {
      await this.set(key, Object.fromEntries(entries));
    }
  },

  // Full housekeeping pass — run at startup and periodically.
  async pruneAll() {
    const DAY = 24 * 3600 * 1000;
    await this.pruneMap(BBD.KEYS.intel, { maxAgeMs: 7 * DAY });
    await this.pruneMap(BBD.KEYS.positions, { maxAgeMs: 7 * DAY });
    await this.pruneMap(BBD.KEYS.alerted, { maxAgeMs: 3 * DAY, maxEntries: 1000 });
    // snooze values are expiry timestamps: drop the expired
    const snoozes = await this.get(BBD.KEYS.snoozes, {});
    const liveSnoozes = Object.fromEntries(
      Object.entries(snoozes).filter(([, until]) => until > Date.now())
    );
    if (Object.keys(liveSnoozes).length !== Object.keys(snoozes).length) {
      await this.set(BBD.KEYS.snoozes, liveSnoozes);
    }
    // dismissed entries only matter while the position is still held
    const [dismissed, positions] = await Promise.all([
      this.get(BBD.KEYS.dismissed, {}),
      this.get(BBD.KEYS.positions, {})
    ]);
    const liveDismissed = Object.fromEntries(
      Object.entries(dismissed).filter(([addr]) => positions[addr])
    );
    if (Object.keys(liveDismissed).length !== Object.keys(dismissed).length) {
      await this.set(BBD.KEYS.dismissed, liveDismissed);
    }
  }
};
