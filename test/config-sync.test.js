// Fails if shared/hot-config.json drifts from the extension's canonical values
// in src/constants.js / src/score.js. The VPS watcher reads the JSON at runtime
// and the extension hardcodes the same values (content scripts can't read files
// synchronously at load) — this test is what keeps the two honest.
//
// Run: node test/config-sync.test.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const shared = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/hot-config.json'), 'utf8'));

// Load constants.js + score.js by exposing their `const BBD = {}` as a global.
global.chrome = { runtime: { id: 'test' } };
const evalInto = (rel) => {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  src = src.replace(/const BBD = \{\};/, 'global.BBD = global.BBD || {};');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
};
evalInto('src/constants.js');
evalInto('src/score.js');
const D = BBD.DEFAULT_SETTINGS;

let pass = 0, fail = 0;
const eq = (name, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name, '\n    shared:', JSON.stringify(a), '\n    ext:   ', JSON.stringify(b)); }
};

eq('memeBadges', shared.memeBadges, D.memeBadges);
eq('memeKeywords', shared.memeKeywords, D.memeKeywords);
eq('ambiguousKeywords', shared.ambiguousKeywords, BBD.AMBIGUOUS_KEYWORDS);
eq('socialWeights', shared.socialWeights, BBD.SOCIAL_WEIGHTS);
eq('hotGates.top10', shared.hotGates.top10, D.hotMaxTop10);
eq('hotGates.dev', shared.hotGates.dev, D.hotMaxDev);
eq('hotGates.snipers', shared.hotGates.snipers, D.hotMaxSnipers);
eq('hotGates.bundlers', shared.hotGates.bundlers, D.hotMaxBundlers);
eq('hotGates.insiders', shared.hotGates.insiders, D.hotMaxInsiders);
eq('hotGates.holders', shared.hotGates.holders, D.hotMinHolders);
eq('hotGates.minProRatio', shared.hotGates.minProRatio, D.hotMinProRatio);
eq('hotGates.maxProRatio', shared.hotGates.maxProRatio, D.hotMaxProRatio);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
