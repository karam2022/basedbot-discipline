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

global.chrome = { runtime: { id: 'test' } };
load('src/constants.js');
load('src/journal.js');
load('src/exitalarm.js');

const addrA = '0x1111111111111111111111111111111111111111';
const addrB = '0x2222222222222222222222222222222222222222';
const keyA = BBD.positionKey(addrA, 'base', 'wallet-a');
const keyB = BBD.positionKey(addrB, 'base', 'wallet-b');

const verdict = (risk, ts = 1) => ({
  ts,
  risk,
  confidence: 'medium',
  headline: `${risk} risk`
});

const trade = ({
  tradeId = 'trade-a',
  positionKey = keyA,
  addr = addrA,
  status = 'open',
  advisorVerdicts
} = {}) => ({
  tradeId,
  positionKey,
  addr,
  chain: 'base',
  wallet: 'wallet-a',
  status,
  openTs: 1,
  ...(advisorVerdicts === undefined ? {} : { advisorVerdicts })
});

const journalOf = (entries) =>
  Object.fromEntries(entries.map((entry) => [entry.tradeId, entry]));

test('decide accepts high and critical risks at or beyond the drop threshold', () => {
  assert.equal(BBD.exitAlarm.decide({
    risk: 'high', changePct5m: -9, dropThresholdPct: 8
  }), true);
  assert.equal(BBD.exitAlarm.decide({
    risk: 'critical', changePct5m: -8, dropThresholdPct: 8
  }), true);
});

test('decide rejects low and medium risks regardless of the drop', () => {
  assert.equal(BBD.exitAlarm.decide({
    risk: 'low', changePct5m: -99, dropThresholdPct: 8
  }), false);
  assert.equal(BBD.exitAlarm.decide({
    risk: 'medium', changePct5m: -99, dropThresholdPct: 8
  }), false);
});

test('decide rejects drops smaller than the threshold', () => {
  assert.equal(BBD.exitAlarm.decide({
    risk: 'critical', changePct5m: -7.99, dropThresholdPct: 8
  }), false);
});

test('decide rejects missing, NaN, and invalid threshold inputs', () => {
  assert.equal(BBD.exitAlarm.decide(), false);
  assert.equal(BBD.exitAlarm.decide(null), false);
  assert.equal(BBD.exitAlarm.decide({
    risk: 'high', changePct5m: NaN, dropThresholdPct: 8
  }), false);
  assert.equal(BBD.exitAlarm.decide({
    risk: 'high', changePct5m: -10
  }), false);
  assert.equal(BBD.exitAlarm.decide({
    risk: 'high', changePct5m: -10, dropThresholdPct: NaN
  }), false);
  assert.equal(BBD.exitAlarm.decide({
    risk: 'high', changePct5m: -10, dropThresholdPct: 0
  }), false);
});

test('riskFor returns the highest-severity verdict on the matching open trade', () => {
  const journal = journalOf([trade({
    advisorVerdicts: [
      verdict('medium', 1),
      verdict('critical', 2),
      verdict('high', 3),
      verdict('low', 4)
    ]
  })]);

  assert.equal(BBD.exitAlarm.riskFor(journal, keyA), 'critical');
});

test('riskFor returns null for closed, unreviewed, and non-matching trades', () => {
  assert.equal(BBD.exitAlarm.riskFor(journalOf([
    trade({ status: 'closed', advisorVerdicts: [verdict('high')] })
  ]), keyA), null);
  assert.equal(BBD.exitAlarm.riskFor(journalOf([
    trade({ advisorVerdicts: undefined })
  ]), keyA), null);
  assert.equal(BBD.exitAlarm.riskFor(journalOf([
    trade({ advisorVerdicts: [verdict('critical')] })
  ]), keyB), null);
});

test('riskFor falls back to the address when position keys differ', () => {
  const oldKey = BBD.positionKey(addrA, 'base', 'wallet-old');
  const currentKey = BBD.positionKey(addrA, 'base', 'wallet-current');
  const journal = journalOf([trade({
    positionKey: oldKey,
    advisorVerdicts: [verdict('high')]
  })]);

  assert.equal(BBD.exitAlarm.riskFor(journal, currentKey), 'high');
});
