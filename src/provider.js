// Pure provider boundary for Phase 4: request descriptions in, validated
// response values out, with no extension state or I/O.
'use strict';

BBD.provider = (() => {
  const OPENAI_ADAPTER = 'openai-compatible';
  const ANTHROPIC_ADAPTER = 'anthropic';
  const DEFAULT_MAX_TOKENS = 1200;
  const MAX_TEXT_LENGTH = 200;
  const MAX_LIST_LENGTH = 8;

  // Model defaults change independently of request shapes, so keep every
  // user-facing provider choice together at this single update point.
  const PRESETS = [
    {
      id: 'openai',
      label: 'OpenAI',
      adapter: OPENAI_ADAPTER,
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-mini'
    },
    {
      id: 'anthropic',
      label: 'Anthropic (Claude)',
      adapter: ANTHROPIC_ADAPTER,
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-opus-4-8'
    },
    {
      id: 'gemini',
      label: 'Google Gemini',
      adapter: OPENAI_ADAPTER,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaultModel: 'gemini-2.5-flash'
    },
    {
      id: 'glm',
      label: 'GLM (Zhipu)',
      adapter: OPENAI_ADAPTER,
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      defaultModel: 'glm-4-plus'
    },
    {
      id: 'kimi',
      label: 'Kimi (Moonshot)',
      adapter: OPENAI_ADAPTER,
      baseUrl: 'https://api.moonshot.cn/v1',
      defaultModel: 'moonshot-v1-8k'
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      adapter: OPENAI_ADAPTER,
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-chat'
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      adapter: OPENAI_ADAPTER,
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: ''
    },
    {
      id: 'custom',
      label: 'Custom (OpenAI-compatible)',
      adapter: OPENAI_ADAPTER,
      baseUrl: '',
      defaultModel: ''
    }
  ];

  const requiredString = (value, name) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${name} is required`);
    }
    return value.trim();
  };

  const promptString = (value, name) => {
    if (value === undefined) return '';
    if (typeof value !== 'string') throw new Error(`${name} must be a string`);
    return value;
  };

  const normalizedBaseUrl = (value) => {
    const baseUrl = requiredString(value, 'baseUrl').replace(/\/+$/, '');
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch (err) {
      throw new Error('baseUrl must be an absolute HTTP(S) URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
      throw new Error('baseUrl must be an absolute HTTP(S) URL without a query or hash');
    }
    return baseUrl;
  };

  const tokenLimit = (value) => {
    if (value === undefined) return DEFAULT_MAX_TOKENS;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error('maxTokens must be a positive integer');
    }
    return value;
  };

  const buildRequest = (options) => {
    if (!options || typeof options !== 'object') {
      throw new Error('request options are required');
    }

    const adapter = requiredString(options.adapter, 'adapter');
    if (adapter !== OPENAI_ADAPTER && adapter !== ANTHROPIC_ADAPTER) {
      throw new Error(`unsupported adapter: ${adapter}`);
    }

    const baseUrl = normalizedBaseUrl(options.baseUrl);
    const model = requiredString(options.model, 'model');
    const apiKey = requiredString(options.apiKey, 'apiKey');
    const system = promptString(options.system, 'system');
    const user = promptString(options.user, 'user');
    const maxTokens = tokenLimit(options.maxTokens);

    // The credential is deliberately used only here, in the adapter's auth
    // header; URLs and bodies are built solely from non-secret inputs.
    if (adapter === OPENAI_ADAPTER) {
      return {
        url: `${baseUrl}/chat/completions`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: {
          model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          response_format: { type: 'json_object' }
        }
      };
    }

    return {
      url: `${baseUrl}/v1/messages`,
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }]
      }
    };
  };

  const shortError = (value) => {
    if (typeof value !== 'string') return null;
    const message = value.trim();
    return message ? message.slice(0, 300) : null;
  };

  const providerError = (adapter, json) => {
    if (!json || typeof json !== 'object') return null;
    const nested = json.error && typeof json.error === 'object'
      ? shortError(json.error.message)
      : null;
    if (nested) return nested;
    return adapter === ANTHROPIC_ADAPTER ? shortError(json.message) : null;
  };

  const parseResponse = (options) => {
    try {
      const input = options && typeof options === 'object' ? options : {};
      const adapter = input.adapter;
      const status = input.status;
      const json = input.json;
      if (!Number.isInteger(status) || status < 200 || status >= 300) {
        return {
          error: providerError(adapter, json) ||
            (Number.isInteger(status) ? `HTTP ${status}` : 'HTTP error')
        };
      }

      if (adapter === OPENAI_ADAPTER) {
        const text = json && Array.isArray(json.choices) &&
          json.choices[0] && json.choices[0].message &&
          json.choices[0].message.content;
        return typeof text === 'string'
          ? { text }
          : { error: 'Unexpected openai-compatible response' };
      }

      if (adapter === ANTHROPIC_ADAPTER) {
        const block = json && Array.isArray(json.content)
          ? json.content.find((item) => item && item.type === 'text')
          : null;
        return block && typeof block.text === 'string'
          ? { text: block.text }
          : { error: 'Unexpected anthropic response' };
      }

      return { error: 'Unsupported adapter' };
    } catch (err) {
      return { error: 'Unexpected provider response' };
    }
  };

  const firstJsonObject = (text) => {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (start < 0) {
        if (char === '{') {
          start = i;
          depth = 1;
        }
        continue;
      }

      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }

    return null;
  };

  const trimmedText = (value) => {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, MAX_TEXT_LENGTH).trim();
  };

  const stringList = (value) => {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (let i = 0; i < value.length && out.length < MAX_LIST_LENGTH; i++) {
      const text = trimmedText(value[i]);
      if (text) out.push(text);
    }
    return out;
  };

  const extractVerdict = (text) => {
    if (typeof text !== 'string') return null;
    try {
      const objectText = firstJsonObject(text);
      if (!objectText) return null;
      const parsed = JSON.parse(objectText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

      const risk = typeof parsed.risk === 'string'
        ? parsed.risk.trim().toLowerCase()
        : '';
      if (!['low', 'medium', 'high', 'critical'].includes(risk)) return null;

      const against = stringList(parsed.against);
      if (!against.length) return null;

      const rawConfidence = typeof parsed.confidence === 'string'
        ? parsed.confidence.trim().toLowerCase()
        : '';
      const confidence = ['low', 'medium', 'high'].includes(rawConfidence)
        ? rawConfidence
        : 'low';

      // Explicit assignment is the safety boundary: advice-like extras such
      // as action never become part of the verdict consumed by the UI.
      return {
        risk,
        headline: trimmedText(parsed.headline),
        supports: stringList(parsed.supports),
        against,
        watchFor: stringList(parsed.watchFor),
        confidence
      };
    } catch (err) {
      return null;
    }
  };

  return { PRESETS, buildRequest, parseResponse, extractVerdict };
})();
