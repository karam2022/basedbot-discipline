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
load('src/price.js');

test('formatPrice keeps tiny prices plain with four significant figures', () => {
  assert.equal(BBD.price.formatPrice(0.0000614427), '$0.00006144');
  assert.equal(BBD.price.formatPrice(0.012732976), '$0.01273');
  assert.equal(BBD.price.formatPrice(1e-9), '$0.000000001');
});

test('formatPrice rounds normal prices and trims trailing zeros', () => {
  assert.equal(BBD.price.formatPrice(2.6567), '$2.657');
  assert.equal(BBD.price.formatPrice(0.5), '$0.5');
});

test('formatPrice uses compact K and M suffixes', () => {
  assert.equal(BBD.price.formatPrice(1234.5), '$1.23K');
  assert.equal(BBD.price.formatPrice(1234567), '$1.23M');
});

test('formatPrice returns empty text for non-positive or non-finite input', () => {
  for (const value of [0, -1, NaN, Infinity, 'x']) {
    assert.equal(BBD.price.formatPrice(value), '');
  }
});
