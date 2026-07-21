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
  }
};
