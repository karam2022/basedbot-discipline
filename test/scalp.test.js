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
load('src/scalp.js');

test('exit blocks honeypots before considering sell tax', () => {
  const summary = BBD.scalp.assess({
    auditDanger: true,
    sellTaxPct: 25,
    maxSellTaxPct: 10
  });
  assert.equal(summary.exit, 'blocked');
  assert.equal(summary.exitReason, 'honeypot');
});

test('exit blocks high sell tax', () => {
  const configured = BBD.scalp.assess({
    auditDanger: null,
    sellTaxPct: 25,
    maxSellTaxPct: 10
  });
  assert.equal(configured.exit, 'blocked');
  assert.equal(configured.exitReason, 'tax');

  const defaultThreshold = BBD.scalp.assess({
    auditDanger: null,
    sellTaxPct: 11
  });
  assert.equal(defaultThreshold.exit, 'blocked');
  assert.equal(defaultThreshold.exitReason, 'tax');
});

test('exit is free when audit or known sell tax affirms exitability', () => {
  for (const input of [
    { auditDanger: false, sellTaxPct: 2 },
    { auditDanger: null, sellTaxPct: 10 }
  ]) {
    const summary = BBD.scalp.assess(input);
    assert.equal(summary.exit, 'free');
    assert.equal('exitReason' in summary, false);
  }
});

test('exit remains unknown until audit or sell tax is known', () => {
  const summary = BBD.scalp.assess({
    auditDanger: null,
    sellTaxPct: null
  });
  assert.equal(summary.exit, 'unknown');
  assert.equal('exitReason' in summary, false);
});

test('flow direction uses the volume-trend thresholds', () => {
  for (const [volumeTrend, expected] of [
    [1.2, 'up'],
    [0.8, 'down'],
    [1.0, 'flat'],
    [null, null]
  ]) {
    assert.equal(BBD.scalp.assess({ flow: { volumeTrend } }).flowDir, expected);
  }
});

test('smart-money flow uses a fifty-dollar deadband', () => {
  for (const [proTraderNetUsd, expected] of [
    [100, 'in'],
    [-100, 'out'],
    [0, 'flat'],
    [NaN, 'flat']
  ]) {
    assert.equal(BBD.scalp.assess({ flow: { proTraderNetUsd } }).smartMoney, expected);
  }
});

test('sniper dumping and wash-risk boundaries are inclusive', () => {
  assert.equal(BBD.scalp.assess({ flow: { sniperNetUsd: -500 } }).snipersDumping, true);
  assert.equal(BBD.scalp.assess({ flow: { sniperNetUsd: -499 } }).snipersDumping, false);
  assert.equal(BBD.scalp.assess({ flow: { top3TraderShare: 0.5 } }).washRisk, true);
  assert.equal(BBD.scalp.assess({ flow: { top3TraderShare: 0.49 } }).washRisk, false);
});

test('buy pressure rounds and dev/count fields pass through', () => {
  const summary = BBD.scalp.assess({
    flow: {
      buyRatio: 0.556,
      devSold: true,
      uniqueBuyers: 17,
      uniqueSellers: 9
    }
  });
  assert.equal(summary.buyPressurePct, 56);
  assert.equal(summary.devSold, true);
  assert.equal(summary.uniqueBuyers, 17);
  assert.equal(summary.uniqueSellers, 9);
});

test('empty and missing-flow inputs never throw and stay well formed', () => {
  const expected = {
    buyPressurePct: null,
    flowDir: null,
    smartMoney: 'flat',
    snipersDumping: false,
    devSold: false,
    washRisk: false,
    uniqueBuyers: 0,
    uniqueSellers: 0,
    sellTaxPct: null,
    exit: 'unknown',
    liqUsd: null
  };
  for (const input of [null, {}, { flow: null }]) {
    assert.doesNotThrow(() => BBD.scalp.assess(input));
    assert.deepEqual(BBD.scalp.assess(input), expected);
  }
});
