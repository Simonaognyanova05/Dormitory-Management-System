const { isIP } = require('node:net');

const DEFAULTS = Object.freeze({
  port: 3000,
  maxFileBytes: 10 * 1024 * 1024,
  maxJsonBodyBytes: 14 * 1024 * 1024,
  maxPdfPages: 3,
  processingTimeoutMs: 40_000,
});

function integerSetting(env, name, fallback, maximum) {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function loadConfig(env = process.env) {
  const host = env.HOST?.trim() || '127.0.0.1';
  const isHostname = host.length <= 253 && /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(host);
  if (!isIP(host) && !isHostname) {
    throw new Error('HOST must be a hostname or IP address, without a URL scheme or port.');
  }

  const maxFileBytes = integerSetting(env, 'MAX_FILE_BYTES', DEFAULTS.maxFileBytes, DEFAULTS.maxFileBytes);
  const maxJsonBodyBytes = integerSetting(env, 'MAX_JSON_BODY_BYTES', DEFAULTS.maxJsonBodyBytes, DEFAULTS.maxJsonBodyBytes);
  const minimumJsonBytes = 4 * Math.ceil(maxFileBytes / 3) + 1024;
  if (maxJsonBodyBytes < minimumJsonBytes) {
    throw new Error('MAX_JSON_BODY_BYTES must allow Base64 encoding of MAX_FILE_BYTES plus 1024 bytes of metadata.');
  }

  const baseUrl = env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('Invalid provider URL.');
    }
  } catch {
    throw new Error('OPENAI_BASE_URL must be an HTTP(S) URL without embedded credentials.');
  }

  // Missing service/AI credentials do not prevent the liveness endpoint from starting.
  // The processing route and AI client will validate them when those features are added.
  return Object.freeze({
    host,
    port: integerSetting(env, 'PORT', DEFAULTS.port, 65535),
    serviceToken: env.SERVICE_TOKEN?.trim() || '',
    pythonCommand: env.PYTHON_COMMAND?.trim() || 'python',
    ai: Object.freeze({
      apiKey: env.OPENAI_API_KEY?.trim() || '',
      model: env.OPENAI_MODEL?.trim() || '',
      baseUrl,
    }),
    limits: Object.freeze({
      maxFileBytes,
      maxJsonBodyBytes,
      maxPdfPages: integerSetting(env, 'MAX_PDF_PAGES', DEFAULTS.maxPdfPages, DEFAULTS.maxPdfPages),
      processingTimeoutMs: integerSetting(env, 'PROCESSING_TIMEOUT_MS', DEFAULTS.processingTimeoutMs, DEFAULTS.processingTimeoutMs),
    }),
  });
}

module.exports = { loadConfig };
