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

  // Chrome forbids audio before the page has seen a user gesture, and even
  // attempting resume() logs an error to the extension console. So: never
  // touch the AudioContext pre-gesture — queue the sound and deliver it on
  // the first interaction instead (trading pages get one within seconds).
  const hadGesture = () =>
    Boolean(globalThis.navigator && navigator.userActivation && navigator.userActivation.hasBeenActive);
  let queued = null;   // last sound requested before the first gesture
  let armed = false;
  const deliverQueued = () => {
    const q = queued;
    queued = null;
    armed = false;
    if (q) play(q.kind, q.volumePct);
  };
  const play = (kind, volumePct) => {
    try {
      if (!hadGesture()) {
        queued = { kind, volumePct }; // keep only the newest — one catch-up chime is plenty
        if (!armed) {
          armed = true;
          globalThis.addEventListener('pointerdown', deliverQueued, { once: true });
          globalThis.addEventListener('keydown', deliverQueued, { once: true });
        }
        return;
      }
      const c = ensureCtx();
      if (c.state === 'suspended') {
        c.resume().then(() => schedule(kind, volumePct)).catch(() => {});
        return;
      }
      schedule(kind, volumePct);
    } catch (err) {
      console.warn('[bbd] sound failed', err);
    }
  };

  return { play };
})();
