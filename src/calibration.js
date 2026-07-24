// Pure, self-limiting calibration for advisor verdicts: no page state, I/O,
// timers, or claims before enough independent trades exist in each bucket.
'use strict';

BBD.calibration = (() => {
  const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
  const CONFIDENCE_LEVELS = ['low', 'medium', 'high'];
  const DIRECTIONAL_MIN = 10;
  const SIGNAL_MIN = 20;
  const CONFOUND_WINDOW_MIN = 30;
  const CONFOUND_WINDOW_MS = CONFOUND_WINDOW_MIN * 60 * 1000;

  const emptyReport = () => ({
    totals: {
      eligible: 0,
      excludedStaleExit: 0,
      closedWithVerdict: 0,
      closedNoVerdict: 0
    },
    levels: {},
    trend: 'insufficient',
    ready: false,
    readyReason: 'need >=20 trades in at least two risk levels; have signal-grade: []',
    confounding: {
      possiblyActedOn: 0,
      windowMin: CONFOUND_WINDOW_MIN
    },
    confidence: {},
    thresholds: {
      directionalMin: DIRECTIONAL_MIN,
      signalMin: SIGNAL_MIN,
      confoundWindowMin: CONFOUND_WINDOW_MIN
    }
  });

  const read = (source, key) => {
    try {
      return source !== null && typeof source === 'object' ? source[key] : undefined;
    } catch (err) {
      return undefined;
    }
  };

  const finite = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  const rounded = (value) => {
    const result = Math.round(value);
    return Object.is(result, -0) ? 0 : result;
  };

  const values = (source) => {
    try {
      return source !== null && typeof source === 'object' ? Object.values(source) : [];
    } catch (err) {
      return [];
    }
  };

  const normalizedValues = (rawJournal) => {
    let normalized = rawJournal;
    // Popup calibration intentionally has only constants.js as a dependency.
    // Journal-aware contexts still use the canonical legacy upgrade; the
    // guarded fallback lets the popup analyze its already-persisted entries
    // without pulling journal.js and its store/creator dependency chain in.
    try {
      if (BBD.journal && typeof BBD.journal.normalize === 'function') {
        normalized = BBD.journal.normalize(rawJournal);
      }
    } catch (err) {
      normalized = rawJournal;
    }
    return values(normalized);
  };

  const validVerdicts = (entry) => {
    const verdicts = read(entry, 'advisorVerdicts');
    if (!Array.isArray(verdicts)) return [];
    const valid = [];
    for (let index = 0; index < verdicts.length; index++) {
      const verdict = read(verdicts, index);
      const risk = read(verdict, 'risk');
      if (!RISK_LEVELS.includes(risk)) continue;
      valid.push({
        risk,
        confidence: read(verdict, 'confidence'),
        ts: finite(read(verdict, 'ts')),
        index
      });
    }
    return valid;
  };

  // The first read is least exposed to hindsight and keeps trades bucketed by
  // the advisor's initial assessment. Last-verdict and maximum-risk views are
  // useful alternatives, but deliberately are not the primary calibration.
  const representative = (verdicts) => verdicts.reduce((earliest, verdict) => {
    if (!earliest) return verdict;
    if (verdict.ts === null) return earliest;
    if (earliest.ts === null || verdict.ts < earliest.ts) return verdict;
    return earliest;
  }, null);

  const accumulator = () => ({
    n: 0,
    wins: 0,
    losses: 0,
    exitTotal: 0
  });

  const grade = (n) => {
    if (n < DIRECTIONAL_MIN) return 'insufficient';
    if (n < SIGNAL_MIN) return 'directional';
    return 'signal';
  };

  const levelStats = (bucket) => ({
    n: bucket.n,
    wins: bucket.wins,
    losses: bucket.losses,
    lossRatePct: rounded((100 * bucket.losses) / bucket.n),
    avgExitPct: rounded(bucket.exitTotal / bucket.n),
    grade: grade(bucket.n)
  });

  const confidenceStats = (bucket) => ({
    n: bucket.n,
    lossRatePct: rounded((100 * bucket.losses) / bucket.n),
    avgExitPct: rounded(bucket.exitTotal / bucket.n),
    grade: grade(bucket.n)
  });

  const possiblyActedOn = (entry, verdicts) => {
    const closeTs = finite(read(entry, 'closeTs'));
    if (closeTs === null) return false;
    let warning = null;
    for (const verdict of verdicts) {
      const riskRank = RISK_LEVELS.indexOf(verdict.risk);
      if (riskRank < RISK_LEVELS.indexOf('high') ||
          verdict.ts === null || verdict.ts > closeTs) continue;
      // For repeated warnings at the same highest severity, the latest one is
      // the actionable event nearest the close.
      if (!warning || riskRank > warning.riskRank ||
          (riskRank === warning.riskRank && verdict.ts > warning.ts)) {
        warning = { riskRank, ts: verdict.ts };
      }
    }
    return !!warning && closeTs - warning.ts <= CONFOUND_WINDOW_MS;
  };

  const analyze = (rawJournal, options) => {
    const report = emptyReport();
    try {
      // `now` is accepted for a stable pure API alongside the other analysis
      // modules. Calibration uses only recorded verdict/close timestamps.
      void options;
      const riskBuckets = {};
      const confidenceBuckets = {};

      for (const entry of normalizedValues(rawJournal)) {
        if (!entry || typeof entry !== 'object' || read(entry, 'status') !== 'closed') continue;
        const verdicts = validVerdicts(entry);
        if (!verdicts.length) {
          report.totals.closedNoVerdict += 1;
          continue;
        }

        report.totals.closedWithVerdict += 1;
        const exitPct = finite(read(entry, 'exitPct'));
        if (exitPct === null) {
          report.totals.excludedStaleExit += 1;
          continue;
        }

        const first = representative(verdicts);
        if (!first) continue;
        report.totals.eligible += 1;

        const riskBucket = riskBuckets[first.risk] || accumulator();
        riskBucket.n += 1;
        riskBucket.exitTotal += exitPct;
        if (exitPct > 0) riskBucket.wins += 1;
        else riskBucket.losses += 1;
        riskBuckets[first.risk] = riskBucket;

        if (CONFIDENCE_LEVELS.includes(first.confidence)) {
          const confidenceBucket = confidenceBuckets[first.confidence] || accumulator();
          confidenceBucket.n += 1;
          confidenceBucket.exitTotal += exitPct;
          if (exitPct > 0) confidenceBucket.wins += 1;
          else confidenceBucket.losses += 1;
          confidenceBuckets[first.confidence] = confidenceBucket;
        }

        // This is a caveat, not an exclusion: acting on a warning can make a
        // useful warning look wrong when the tracked exit is captured early.
        if (possiblyActedOn(entry, verdicts)) {
          report.confounding.possiblyActedOn += 1;
        }
      }

      for (const level of RISK_LEVELS) {
        if (riskBuckets[level]) report.levels[level] = levelStats(riskBuckets[level]);
      }
      for (const confidence of CONFIDENCE_LEVELS) {
        if (confidenceBuckets[confidence]) {
          report.confidence[confidence] = confidenceStats(confidenceBuckets[confidence]);
        }
      }

      const signalLevels = RISK_LEVELS.filter((level) =>
        report.levels[level] && report.levels[level].grade === 'signal');
      if (signalLevels.length >= 2) {
        const rates = signalLevels.map((level) => report.levels[level].lossRatePct);
        const expected = rates.every((rate, index) => index === 0 || rate >= rates[index - 1]);
        const inverted = rates.every((rate, index) => index === 0 || rate < rates[index - 1]);
        report.trend = expected ? 'expected' : inverted ? 'inverted' : 'mixed';
        report.ready = true;
        report.readyReason = `comparing signal-grade risk levels: [${signalLevels.join(', ')}]`;
      } else {
        report.readyReason =
          `need >=20 trades in at least two risk levels; have signal-grade: [${signalLevels.join(', ')}]`;
      }
    } catch (err) {
      return emptyReport();
    }
    return report;
  };

  return { analyze };
})();
