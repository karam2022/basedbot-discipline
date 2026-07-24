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
load('src/provider.js');

const SYSTEM = 'Return a concise JSON risk verdict.';
const USER = '{"symbol":"TEST","rules":{"score":3}}';
const MODEL = 'synthetic-model';

const requestOptions = (overrides = {}) => ({
  adapter: 'openai-compatible',
  baseUrl: 'https://provider.test/v1',
  model: MODEL,
  apiKey: 'sk-test-default',
  system: SYSTEM,
  user: USER,
  ...overrides
});

test('buildRequest creates an openai-compatible request without leaking the key', () => {
  const apiKey = 'sk-test-openai-xxx';
  const request = BBD.provider.buildRequest(requestOptions({
    baseUrl: 'https://provider.test/v1/',
    apiKey
  }));

  assert.equal(request.url, 'https://provider.test/v1/chat/completions');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(request.body.model, MODEL);
  assert.equal(request.body.max_tokens, 1200);
  assert.deepEqual(request.body.messages, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: USER }
  ]);
  assert.deepEqual(request.body.response_format, { type: 'json_object' });

  const otherHeaders = { ...request.headers };
  delete otherHeaders.Authorization;
  assert.equal(request.url.includes(apiKey), false);
  assert.equal(JSON.stringify(request.body).includes(apiKey), false);
  assert.equal(JSON.stringify(otherHeaders).includes(apiKey), false);
});

test('buildRequest creates an anthropic request with native headers and body shape', () => {
  const apiKey = 'sk-test-anthropic-xxx';
  const request = BBD.provider.buildRequest(requestOptions({
    adapter: 'anthropic',
    baseUrl: 'https://anthropic.test/',
    apiKey,
    maxTokens: 777
  }));

  assert.equal(request.url, 'https://anthropic.test/v1/messages');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['x-api-key'], apiKey);
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(request.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.deepEqual(request.body, {
    model: MODEL,
    max_tokens: 777,
    system: SYSTEM,
    messages: [{ role: 'user', content: USER }]
  });

  const otherHeaders = { ...request.headers };
  delete otherHeaders['x-api-key'];
  assert.equal(request.url.includes(apiKey), false);
  assert.equal(JSON.stringify(request.body).includes(apiKey), false);
  assert.equal(JSON.stringify(otherHeaders).includes(apiKey), false);
});

test('buildRequest throws clear errors for missing required configuration', () => {
  for (const field of ['adapter', 'baseUrl', 'model', 'apiKey']) {
    const options = requestOptions();
    delete options[field];
    assert.throws(
      () => BBD.provider.buildRequest(options),
      new RegExp(field, 'i'),
      field
    );
  }
});

test('parseResponse extracts successful text for both adapters', () => {
  assert.deepEqual(BBD.provider.parseResponse({
    adapter: 'openai-compatible',
    status: 200,
    json: { choices: [{ message: { content: '{"risk":"low"}' } }] }
  }), { text: '{"risk":"low"}' });

  assert.deepEqual(BBD.provider.parseResponse({
    adapter: 'anthropic',
    status: 201,
    json: {
      content: [
        { type: 'tool_use', id: 'synthetic-tool' },
        { type: 'text', text: '{"risk":"medium"}' },
        { type: 'text', text: 'ignored second text block' }
      ]
    }
  }), { text: '{"risk":"medium"}' });
});

test('parseResponse returns provider messages for non-2xx responses', () => {
  assert.deepEqual(BBD.provider.parseResponse({
    adapter: 'openai-compatible',
    status: 401,
    json: { error: { message: 'Synthetic key rejected' } }
  }), { error: 'Synthetic key rejected' });

  assert.deepEqual(BBD.provider.parseResponse({
    adapter: 'anthropic',
    status: 429,
    json: { message: 'Synthetic rate limit' }
  }), { error: 'Synthetic rate limit' });

  assert.deepEqual(BBD.provider.parseResponse({
    adapter: 'anthropic',
    status: 503,
    json: {}
  }), { error: 'HTTP 503' });
});

test('parseResponse returns errors rather than throwing on malformed success shapes', () => {
  for (const input of [
    { adapter: 'openai-compatible', status: 200, json: { choices: [] } },
    { adapter: 'openai-compatible', status: 200, json: null },
    { adapter: 'anthropic', status: 200, json: { content: [{ type: 'text' }] } },
    { adapter: 'anthropic', status: 200, json: { content: 'not-an-array' } },
    null,
    undefined
  ]) {
    let result;
    assert.doesNotThrow(() => {
      result = BBD.provider.parseResponse(input);
    });
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error);
  }
});

test('extractVerdict validates clean JSON and drops stray action fields', () => {
  const verdict = BBD.provider.extractVerdict(JSON.stringify({
    risk: 'HIGH',
    headline: '  Concentrated flow needs caution.  ',
    supports: ['  Strong liquidity  '],
    against: ['  Three wallets dominate volume  '],
    watchFor: ['  Dev sells  '],
    confidence: 'MEDIUM',
    action: 'buy',
    arbitrary: { nested: true }
  }));

  assert.deepEqual(verdict, {
    risk: 'high',
    headline: 'Concentrated flow needs caution.',
    supports: ['Strong liquidity'],
    against: ['Three wallets dominate volume'],
    watchFor: ['Dev sells'],
    confidence: 'medium'
  });
  assert.equal(Object.hasOwn(verdict, 'action'), false);
});

test('extractVerdict accepts JSON inside a json code fence', () => {
  const text = [
    '```json',
    JSON.stringify({
      risk: 'low',
      headline: 'Synthetic fenced verdict',
      supports: [],
      against: ['Limited history'],
      watchFor: [],
      confidence: 'high'
    }),
    '```'
  ].join('\n');

  assert.equal(BBD.provider.extractVerdict(text).headline, 'Synthetic fenced verdict');
});

test('extractVerdict finds balanced JSON wrapped in prose', () => {
  const text = [
    'Here is the requested assessment:',
    '{"risk":"critical","headline":"Quoted \\"brace } stays text\\"",',
    '"supports":["Audit warning"],"against":["Signal may be stale"],',
    '"watchFor":["Fresh liquidity"],"confidence":"high"}',
    'This is not trading advice.'
  ].join(' ');

  assert.deepEqual(BBD.provider.extractVerdict(text), {
    risk: 'critical',
    headline: 'Quoted "brace } stays text"',
    supports: ['Audit warning'],
    against: ['Signal may be stale'],
    watchFor: ['Fresh liquidity'],
    confidence: 'high'
  });
});

test('extractVerdict skips a reasoning-prose object and takes the final verdict', () => {
  // Reasoning models emit an earlier {...} that is valid JSON but not a verdict;
  // the real answer comes last. The parser must not stop at the first object.
  const text = [
    'Let me reason. Consider the metrics {"note":"top10 is 19% and holders 5010"}.',
    'That looks reasonable, so my final answer is:',
    '```json',
    '{"risk":"medium","headline":"Concentration is moderate.",',
    '"supports":["Many holders"],"against":["Top wallets still cluster"],',
    '"watchFor":["A dev sell"],"confidence":"medium"}',
    '```'
  ].join('\n');

  assert.deepEqual(BBD.provider.extractVerdict(text), {
    risk: 'medium',
    headline: 'Concentration is moderate.',
    supports: ['Many holders'],
    against: ['Top wallets still cluster'],
    watchFor: ['A dev sell'],
    confidence: 'medium'
  });
});

test('extractVerdict rejects missing counter-arguments and invalid risk', () => {
  assert.equal(BBD.provider.extractVerdict(JSON.stringify({
    risk: 'medium',
    headline: 'No counter-case supplied',
    supports: ['Synthetic support']
  })), null);

  assert.equal(BBD.provider.extractVerdict(JSON.stringify({
    risk: 'extreme',
    against: ['Synthetic counter-case']
  })), null);
});

test('extractVerdict trims and caps strings and arrays', () => {
  const verdict = BBD.provider.extractVerdict(JSON.stringify({
    risk: ' medium ',
    headline: `  ${'h'.repeat(240)}  `,
    supports: [
      '   ',
      ...Array.from({ length: 12 }, (_, i) => `  support ${i}  `)
    ],
    against: [`  ${'a'.repeat(240)}  `, 42, null],
    watchFor: ['  first watch  ', {}, '  second watch  '],
    confidence: 'unknown'
  }));

  assert.equal(verdict.risk, 'medium');
  assert.equal(verdict.headline.length, 200);
  assert.equal(verdict.supports.length, 8);
  assert.deepEqual(verdict.supports, [
    'support 0', 'support 1', 'support 2', 'support 3',
    'support 4', 'support 5', 'support 6', 'support 7'
  ]);
  assert.equal(verdict.against.length, 1);
  assert.equal(verdict.against[0].length, 200);
  assert.deepEqual(verdict.watchFor, ['first watch', 'second watch']);
  assert.equal(verdict.confidence, 'low');
});

test('extractVerdict returns null for non-strings, garbage, and invalid JSON', () => {
  for (const value of [
    null,
    undefined,
    42,
    {},
    'no object here',
    'prefix {not valid JSON} suffix',
    '{"risk":"low","against":["unterminated]"'
  ]) {
    assert.equal(BBD.provider.extractVerdict(value), null);
  }
});

test('PRESETS expose the required providers and only known adapters', () => {
  const requiredIds = [
    'openai', 'anthropic', 'gemini', 'glm',
    'kimi', 'deepseek', 'openrouter', 'custom'
  ];
  assert.deepEqual(BBD.provider.PRESETS.map((preset) => preset.id), requiredIds);

  for (const preset of BBD.provider.PRESETS) {
    assert.equal(typeof preset.id, 'string');
    assert.ok(preset.id);
    assert.equal(typeof preset.label, 'string');
    assert.ok(preset.label);
    assert.equal(Object.hasOwn(preset, 'baseUrl'), true);
    assert.equal(typeof preset.baseUrl, 'string');
    assert.equal(Object.hasOwn(preset, 'defaultModel'), true);
    assert.equal(typeof preset.defaultModel, 'string');
    assert.ok(['openai-compatible', 'anthropic'].includes(preset.adapter));
  }
});
