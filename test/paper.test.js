// Paper-trading strategy core — the numbers that decide "beats zero" must be
// right, so the ladder / stop / trailing / slippage math is pinned here.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'vps-watcher', 'paper.mjs')).href);

test('evaluate: ladder fills the +30% rung and only that rung', async () => {
  const { evaluate, DEFAULTS } = await load();
  const pos = { entryMc: 100, peakMc: 100, remaining: 1,
    tranches: DEFAULTS.paperLadder.map((t) => ({ ...t, filled: false })) };
  const r = evaluate(pos, { mc: 135, holdersDropPct: 0, ageMin: 5, source: 'feed' }, DEFAULTS);
  assert.equal(r.fills.length, 1);
  assert.match(r.fills[0].reason, /TP \+30%/);
  assert.equal(r.close, false);
});

test('evaluate: at +350% all three rungs fill and the runner remains', async () => {
  const { evaluate, DEFAULTS } = await load();
  const pos = { entryMc: 100, peakMc: 100, remaining: 1,
    tranches: DEFAULTS.paperLadder.map((t) => ({ ...t, filled: false })) };
  const r = evaluate(pos, { mc: 450, holdersDropPct: 0, ageMin: 10, source: 'feed' }, DEFAULTS);
  const filled = r.fills.reduce((a, f) => a + f.frac, 0);
  assert.ok(Math.abs(filled - 0.9) < 1e-9, 'three rungs = 0.9 sold');
  assert.equal(r.close, false, 'runner still open');
});

test('evaluate: hard stop-loss dumps everything and closes', async () => {
  const { evaluate, DEFAULTS } = await load();
  const pos = { entryMc: 100, peakMc: 100, remaining: 1,
    tranches: DEFAULTS.paperLadder.map((t) => ({ ...t, filled: false })) };
  const r = evaluate(pos, { mc: 70, holdersDropPct: 0, ageMin: 5, source: 'feed' }, DEFAULTS);
  assert.equal(r.close, true);
  assert.equal(r.fills[0].frac, 1);
  assert.match(r.fills[0].reason, /stop-loss/);
});

test('evaluate: holder-bleed kill overrides everything', async () => {
  const { evaluate, DEFAULTS } = await load();
  const pos = { entryMc: 100, peakMc: 100, remaining: 1,
    tranches: DEFAULTS.paperLadder.map((t) => ({ ...t, filled: false })) };
  const r = evaluate(pos, { mc: 200, holdersDropPct: 20, ageMin: 5, source: 'feed' }, DEFAULTS);
  assert.equal(r.close, true);
  assert.match(r.fills[0].reason, /kill/);
});

test('evaluate: trailing stop on the runner after it armed', async () => {
  const { evaluate, DEFAULTS } = await load();
  // runner only: three rungs already filled, 0.1 left, peaked at +200%, now +120%
  const pos = { entryMc: 100, peakMc: 300, remaining: 0.1,
    tranches: DEFAULTS.paperLadder.map((t) => ({ ...t, filled: true })) };
  const r = evaluate(pos, { mc: 220, holdersDropPct: 0, ageMin: 30, source: 'feed' }, DEFAULTS);
  assert.equal(r.close, true);
  assert.match(r.fills[0].reason, /trailing/);
});

test('positionReturnPct: slippage makes a flat exit slightly negative', async () => {
  const { positionReturnPct } = await load();
  // bought at effEntry (already slipped up), sold at exactly entry (slipped down)
  const pos = { effEntry: 103, fillLog: [{ frac: 1, sellPrice: 97 }] };
  const ret = positionReturnPct(pos);
  assert.ok(ret < 0, 'round-trip slippage on a flat move loses');
  assert.ok(ret > -10, 'but only by the slippage, not a crash');
});

test('summarize: win rate, avg, and beatsZero', async () => {
  const { summarize } = await load();
  const s = summarize([
    { returnPct: 45, holdMin: 20, marksLive: 8, marksStale: 0 },
    { returnPct: -22, holdMin: 90, marksLive: 5, marksStale: 1 },
    { returnPct: 120, holdMin: 40, marksLive: 6, marksStale: 0 }
  ]);
  assert.equal(s.trades, 3);
  assert.equal(s.winRatePct, 67);
  assert.ok(s.beatsZero);
  assert.ok(s.liveMarkPct >= 90);
});

test('createPaperTrader: open respects max-concurrent and no-price', async () => {
  const { createPaperTrader } = await load();
  const store = {};
  const pt = createPaperTrader({
    loadJson: (p, f) => store[p] || f,
    saveJson: (p, d) => { store[p] = d; },
    appendLine: () => {},
    readTrades: () => [],
    posPath: 'pos', logPath: 'log',
    settings: { paperMaxConcurrent: 2 }
  });
  assert.ok(pt.open('0xa', 'robinhood', 'A', 100, { holders: 200 }).opened);
  assert.equal(pt.open('0xnoprice', 'robinhood', 'NP', 0, {}).skipped, 'no-entry-price');
  assert.equal(pt.open('0xa', 'robinhood', 'A', 100, {}), null, 're-opening an open token returns null');
  assert.ok(pt.open('0xb', 'robinhood', 'B', 100, { holders: 200 }).opened);
  assert.equal(pt.open('0xc', 'robinhood', 'C', 100, {}).skipped, 'max-concurrent');
});

test('createPaperTrader: a full ladder + runner trail logs one closed trade', async () => {
  const { createPaperTrader } = await load();
  const store = {}; const log = [];
  const pt = createPaperTrader({
    loadJson: (p, f) => store[p] || f,
    saveJson: (p, d) => { store[p] = JSON.parse(JSON.stringify(d)); },
    appendLine: (_p, line) => log.push(JSON.parse(line)),
    readTrades: () => log,
    posPath: 'pos', logPath: 'log'
  });
  pt.open('0xz', 'robinhood', 'ZZZ', 100, { holders: 300 });
  pt.mark({ '0xz': { mc: 135, holders: 300, source: 'feed' } });   // +30 rung
  pt.mark({ '0xz': { mc: 210, holders: 320, source: 'feed' } });   // +100 rung
  pt.mark({ '0xz': { mc: 420, holders: 340, source: 'feed' } });   // +300 rung, runner left
  const closed = pt.mark({ '0xz': { mc: 300, holders: 340, source: 'feed' } }); // trail from +320 peak
  assert.equal(closed.length, 1);
  assert.equal(log.length, 1);
  assert.ok(log[0].returnPct > 0, 'a token that 4x then pulled back is a big win');
  assert.ok(log[0].exits.length >= 4);
});
