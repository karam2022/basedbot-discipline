const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const load = (rel) => {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  src = src.replace(/const BBD = \{\};/, 'global.BBD = global.BBD || {};');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
};

load('src/constants.js');
load('src/journal.js');
load('src/calibration.js');

const minute = 60 * 1000;
let nextId = 1;

const closed = (exitPct, advisorVerdicts, overrides = {}) => {
  const id = `trade-${nextId++}`;
  return {
    tradeId: id,
    positionKey: `base|wallet|0x${id}`,
    addr: `0x${id}`,
    status: 'closed',
    exitPct,
    closeTs: 100 * minute,
    advisorVerdicts,
    ...overrides
  };
};

const journalOf = (entries) => Object.fromEntries(entries.map((entry) => [entry.tradeId, entry]));

const verdict = (risk, ts = minute, confidence = 'medium') => ({
  ts,
  risk,
  confidence,
  headline: `${risk} risk`
});

const many = (risk, count, losses, confidence = 'medium') => Array.from(
  { length: count },
  (_, index) => closed(index < losses ? -10 : 10, [verdict(risk, minute, confidence)])
);

test('eligibility counts only closed trades with fresh exits and valid verdicts', () => {
  const fresh = closed(5, [verdict('low')]);
  const stale = closed(null, [verdict('high')]);
  const noVerdict = closed(-2, []);
  const open = {
    ...closed(-4, [verdict('critical')]),
    status: 'open'
  };

  const report = BBD.calibration.analyze(journalOf([fresh, stale, noVerdict, open]), {
    now: 200 * minute
  });

  assert.deepEqual(report.totals, {
    eligible: 1,
    excludedStaleExit: 1,
    closedWithVerdict: 2,
    closedNoVerdict: 1
  });
  assert.deepEqual(report.levels, {
    low: {
      n: 1,
      wins: 1,
      losses: 0,
      lossRatePct: 0,
      avgExitPct: 5,
      grade: 'insufficient'
    }
  });
});

test('the earliest valid verdict represents the trade', () => {
  const trade = closed(-8, [
    verdict('critical', 20 * minute, 'high'),
    verdict('low', 10 * minute, 'low'),
    verdict('medium', 15 * minute, 'medium')
  ]);

  const report = BBD.calibration.analyze(journalOf([trade]), { now: 200 * minute });

  assert.equal(report.levels.low.n, 1);
  assert.equal(report.levels.critical, undefined);
  assert.deepEqual(report.confidence.low, {
    n: 1,
    lossRatePct: 100,
    avgExitPct: -8,
    grade: 'insufficient'
  });
});

test('per-level outcome counts and rounded rates are hand-computable', () => {
  const report = BBD.calibration.analyze(journalOf([
    closed(12, [verdict('medium')]),
    closed(-6, [verdict('medium')]),
    closed(0, [verdict('medium')]),
    closed(-8, [verdict('high')])
  ]), { now: 200 * minute });

  assert.deepEqual(report.levels.medium, {
    n: 3,
    wins: 1,
    losses: 2,
    lossRatePct: 67,
    avgExitPct: 2,
    grade: 'insufficient'
  });
  assert.deepEqual(report.levels.high, {
    n: 1,
    wins: 0,
    losses: 1,
    lossRatePct: 100,
    avgExitPct: -8,
    grade: 'insufficient'
  });
});

test('grades enforce the directional and signal sample minimums', () => {
  const report = BBD.calibration.analyze(journalOf([
    ...many('low', 9, 3),
    ...many('medium', 10, 4),
    ...many('high', 19, 8),
    ...many('critical', 20, 12)
  ]), { now: 200 * minute });

  assert.equal(report.levels.low.grade, 'insufficient');
  assert.equal(report.levels.medium.grade, 'directional');
  assert.equal(report.levels.high.grade, 'directional');
  assert.equal(report.levels.critical.grade, 'signal');
});

test('trend stays insufficient until two levels reach signal grade', () => {
  const report = BBD.calibration.analyze(journalOf([
    ...many('low', 19, 2),
    ...many('high', 20, 10)
  ]), { now: 200 * minute });

  assert.equal(report.trend, 'insufficient');
  assert.equal(report.ready, false);
  assert.match(report.readyReason, /signal-grade: \[high\]/);
});

test('trend is expected when signal-grade loss rates do not decrease with risk', () => {
  const report = BBD.calibration.analyze(journalOf([
    ...many('low', 20, 4),
    ...many('high', 20, 12)
  ]), { now: 200 * minute });

  assert.equal(report.trend, 'expected');
  assert.equal(report.ready, true);
});

test('trend is inverted only when every signal-grade loss rate strictly falls', () => {
  const report = BBD.calibration.analyze(journalOf([
    ...many('low', 20, 16),
    ...many('medium', 20, 10),
    ...many('critical', 20, 4)
  ]), { now: 200 * minute });

  assert.equal(report.trend, 'inverted');
  assert.equal(report.ready, true);
});

test('trend is mixed when signal-grade loss rates change direction', () => {
  const report = BBD.calibration.analyze(journalOf([
    ...many('low', 20, 4),
    ...many('medium', 20, 14),
    ...many('high', 20, 8)
  ]), { now: 200 * minute });

  assert.equal(report.trend, 'mixed');
  assert.equal(report.ready, true);
});

test('confounding counts recent high/critical warnings without removing trades', () => {
  const recent = closed(-5, [verdict('critical', 90 * minute)], { closeTs: 100 * minute });
  const old = closed(-6, [verdict('high', 60 * minute)], { closeTs: 100 * minute });
  const low = closed(-7, [verdict('low', 95 * minute)], { closeTs: 100 * minute });

  const report = BBD.calibration.analyze(journalOf([recent, old, low]), {
    now: 200 * minute
  });

  assert.deepEqual(report.confounding, { possiblyActedOn: 1, windowMin: 30 });
  assert.equal(report.totals.eligible, 3);
  assert.equal(Object.values(report.levels).reduce((sum, level) => sum + level.n, 0), 3);
});

test('popup fallback analyzes persisted entries when journal.js is not loaded', () => {
  const journalModule = BBD.journal;
  BBD.journal = null;
  try {
    const report = BBD.calibration.analyze(journalOf([
      closed(7, [verdict('medium')])
    ]), { now: 200 * minute });
    assert.equal(report.totals.eligible, 1);
    assert.equal(report.levels.medium.avgExitPct, 7);
  } finally {
    BBD.journal = journalModule;
  }
});

test('malformed journals and entries never throw and return a well-formed empty report', () => {
  for (const input of [null, {}, 42, 'journal', { bad: null }, { bad: 'entry' }]) {
    let report;
    assert.doesNotThrow(() => {
      report = BBD.calibration.analyze(input, { now: 200 * minute });
    });
    assert.deepEqual(report.totals, {
      eligible: 0,
      excludedStaleExit: 0,
      closedWithVerdict: 0,
      closedNoVerdict: 0
    });
    assert.deepEqual(report.levels, {});
    assert.deepEqual(report.confidence, {});
    assert.equal(report.trend, 'insufficient');
    assert.equal(report.ready, false);
    assert.deepEqual(report.confounding, { possiblyActedOn: 0, windowMin: 30 });
    assert.deepEqual(report.thresholds, {
      directionalMin: 10,
      signalMin: 20,
      confoundWindowMin: 30
    });
  }
});
