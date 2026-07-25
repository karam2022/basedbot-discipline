// Lets the trader drag the floating read-outs anywhere and remembers where.
// The modules that own each node keep positioning it by default; once a node
// carries a stored position, its own positioner steps aside and this owns it.
// Dragging a node needs pointer events, so a moved panel stops passing clicks
// through to the page beneath — the trade-off for being able to move it at all.
'use strict';

BBD.drag = (() => {
  const INTERACTIVE = 'button, summary, a, input, select, textarea';
  const MOVE_THRESHOLD = 4; // px before a press counts as a drag, not a click
  let positions = {};
  let enabled = true;
  let hydrating = null;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  // Loaded once into memory so the node positioners can check synchronously.
  const hydrate = () => {
    if (hydrating) return hydrating;
    hydrating = (async () => {
      try {
        const stored = await BBD.store.get(BBD.KEYS.panelPos, {});
        if (stored && typeof stored === 'object') positions = stored;
        const settings = await BBD.store.settings();
        enabled = settings.panelsDraggable !== false;
      } catch (err) {
        // An unreadable cache just means everything keeps its default place.
      }
    })();
    return hydrating;
  };

  const isCustom = (id) => !!(id && positions[id]);

  const persist = () => {
    try {
      BBD.store.set(BBD.KEYS.panelPos, positions);
    } catch (err) {
      // A lost save just means the position resets next reload.
    }
  };

  // Reapplies the stored top-left each time it is called, re-clamped to the
  // viewport so a smaller window or a grown panel can never strand a node
  // off-screen where it cannot be grabbed back.
  const apply = (el) => {
    try {
      if (!el || !el.id) return false;
      const pos = positions[el.id];
      if (!pos) return false;
      let left = Number(pos.left);
      let top = Number(pos.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return false;
      const w = el.offsetWidth || 0;
      const h = el.offsetHeight || 0;
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      if (w && vw) left = clamp(left, 0, Math.max(0, vw - w));
      if (h && vh) top = clamp(top, 0, Math.max(0, vh - h));
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      return true;
    } catch (err) {
      return false;
    }
  };

  // Double-click hands the node back to its own positioner.
  const reset = (el) => {
    try {
      if (!el || !el.id) return;
      delete positions[el.id];
      el.style.left = '';
      el.style.top = '';
      el.style.right = '';
      el.style.bottom = '';
      persist();
    } catch (err) {
      // Ignore; the node simply keeps its current place until the next render.
    }
  };

  // A press below the move threshold is a click and is left to whatever control
  // it landed on (the KI-Check button, the close ×, an expandable section); a
  // press that actually moves becomes a drag, and the click it would otherwise
  // fire on release is swallowed so dragging by the button never also triggers
  // it. This is what lets the whole card, buttons included, be a drag handle.
  const swallowNextClick = () => {
    try {
      const swallow = (event) => {
        event.stopPropagation();
        event.preventDefault();
        cleanup();
      };
      const cleanup = () => {
        document.removeEventListener('click', swallow, true);
        clearTimeout(timer);
      };
      const timer = setTimeout(cleanup, 300);
      document.addEventListener('click', swallow, true);
    } catch (err) {
      // Worst case a drag-release also clicks; harmless for these controls.
    }
  };

  const onPointerDown = (el, event) => {
    try {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = el.getBoundingClientRect();
      let dragging = false;

      const move = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!dragging && Math.abs(dx) + Math.abs(dy) < MOVE_THRESHOLD) return;
        dragging = true;
        el.style.cursor = 'grabbing';
        el.style.left = `${Math.round(rect.left + dx)}px`;
        el.style.top = `${Math.round(rect.top + dy)}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        ev.preventDefault();
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        el.style.cursor = 'grab';
        if (!dragging) return;
        const r = el.getBoundingClientRect();
        positions[el.id] = { left: Math.round(r.left), top: Math.round(r.top) };
        persist();
        swallowNextClick();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    } catch (err) {
      // A failed drag start leaves the node exactly where it was.
    }
  };

  // Idempotent: safe to call on every render. Wires the handlers once, then
  // just reapplies any stored position so a re-created node keeps its place.
  const register = (el) => {
    try {
      if (!el || !enabled) return;
      if (el.dataset && el.dataset.bbdDrag === '1') {
        apply(el);
        return;
      }
      if (el.dataset) el.dataset.bbdDrag = '1';
      el.style.cursor = 'grab';
      el.style.pointerEvents = 'auto';
      el.title = 'Drag to move · double-click to reset';
      el.addEventListener('pointerdown', (event) => onPointerDown(el, event));
      el.addEventListener('dblclick', (event) => {
        const target = event.target;
        if (target && target.closest && target.closest(INTERACTIVE)) return;
        reset(el);
      });
      apply(el);
    } catch (err) {
      // Registration is best-effort; a node that fails to wire just stays put.
    }
  };

  return { hydrate, register, apply, isCustom, reset };
})();
