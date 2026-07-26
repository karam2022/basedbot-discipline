// Banner alert sounds — synthesized with the Web Audio API, no audio files.
// Two motifs: 'up' is a rising four-note sparkle (take profit — good news),
// 'down' is a soft two-note descending tone (stop-loss / peak-giveback —
// attention, not alarm). Distinct enough to tell apart without looking.
// Loaded by both the content scripts (after constants.js) and the popup
// (standalone), hence the typeof guard.
'use strict';

(typeof BBD !== 'undefined' ? BBD : (globalThis.BBD = globalThis.BBD || {})).sounds = (() => {
  let ctx = null;
  const ensureCtx = () => {
    if (!ctx) ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    return ctx;
  };

  // [freq Hz, start s, length s, peak gain] per note; master gain scales all.
  const MOTIFS = {
    up: {
      wave: 'sine',
      notes: [
        [523.25, 0.00, 0.28, 0.9],   // C5
        [659.25, 0.09, 0.28, 0.8],   // E5
        [783.99, 0.18, 0.30, 0.8],   // G5
        [1046.50, 0.27, 0.42, 1.0]   // C6 — the little lift at the end
      ]
    },
    down: {
      wave: 'triangle',
      notes: [
        [392.00, 0.00, 0.34, 1.0],   // G4
        [311.13, 0.20, 0.50, 0.85]   // Eb4 — settles low, "heads up"
      ]
    }
  };

  const schedule = (kind, volumePct) => {
    const c = ensureCtx();
    const motif = MOTIFS[kind] || MOTIFS.up;
    const master = Math.max(0, Math.min(100, volumePct ?? 40)) / 100 * 0.5;
    if (master <= 0) return;
    const t0 = c.currentTime + 0.02;
    for (const [freq, at, len, peak] of motif.notes) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = motif.wave;
      osc.frequency.value = freq;
      // soft attack, exponential release — "lovely", not beepy
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(master * peak, t0 + at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      osc.connect(gain).connect(c.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + len + 0.05);
    }
  };

  // Chrome may keep a fresh AudioContext suspended until the user interacts
  // with the page. Trading pages get constant interaction, so retry the sound
  // once on the next click/keypress instead of dropping it.
  let retryArmed = false;
  const play = (kind, volumePct) => {
    try {
      const c = ensureCtx();
      if (c.state === 'suspended') {
        c.resume().catch(() => {});
        if (c.state === 'suspended' && !retryArmed) {
          retryArmed = true;
          const once = () => {
            retryArmed = false;
            c.resume().then(() => schedule(kind, volumePct)).catch(() => {});
          };
          globalThis.addEventListener('pointerdown', once, { once: true });
          globalThis.addEventListener('keydown', once, { once: true });
          return;
        }
      }
      schedule(kind, volumePct);
    } catch (err) {
      console.warn('[bbd] sound failed', err);
    }
  };

  return { play };
})();
