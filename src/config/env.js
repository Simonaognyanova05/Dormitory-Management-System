const { isIP } = require('node:net');

const DEFAULTS = Object.freeze({
  port: 3000,
  maxFileBytes: 10 * 1024 * 1024,
  maxJsonBodyBytes: 14 * 1024 * 1024,
  maxPdfPages: 3,
  maxImagePixels: 20_000_000,
  processingTimeoutMs: 40_000,
  maxPreprocessStdoutBytes: 64 * 1024 * 1024,
  maxPreprocessStderrBytes: 64 * 1024,
  maxAiResponseBytes: 256 * 1024,
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
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Invalid provider URL.');
    }
  } catch {
    throw new Error('OPENAI_BASE_URL must be an HTTP(S) base URL without credentials, query or fragment.');
  }

  const provider = env.AI_PROVIDER?.trim().toLowerCase() || 'openai';
  if (!['openai', 'mock'].includes(provider)) throw new Error('AI_PROVIDER must be openai or mock.');
  const imageDetail = env.OPENAI_IMAGE_DETAIL?.trim().toLowerCase() || 'high';
  if (!['low', 'high', 'auto', 'original'].includes(imageDetail)) throw new Error('OPENAI_IMAGE_DETAIL must be low, high, auto or original.');
  let temperature;
  if (env.OPENAI_TEMPERATURE?.trim()) {
    temperature = Number(env.OPENAI_TEMPERATURE);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('OPENAI_TEMPERATURE must be between 0 and 2, or empty.');
  }

  // Missing service/AI credentials do not prevent the liveness endpoint from starting.
  // The processing route and AI client validate their credentials when needed.
  return Object.freeze({
    host,
    port: integerSetting(env, 'PORT', DEFAULTS.port, 65535),
    serviceToken: env.SERVICE_TOKEN?.trim() || '',
    pythonCommand: env.PYTHON_COMMAND?.trim() || 'python',
    ai: Object.freeze({
      provider,
      apiKey: env.OPENAI_API_KEY?.trim() || '',
      model: env.OPENAI_MODEL?.trim() || '',
      baseUrl,
      imageDetail,
      temperature,
      maxOutputTokens: integerSetting(env, 'AI_MAX_OUTPUT_TOKENS', 2048, 8192),
      requestTimeoutMs: integerSetting(env, 'AI_REQUEST_TIMEOUT_MS', 20_000, 40_000),
    }),
    limits: Object.freeze({
      maxFileBytes,
      maxJsonBodyBytes,
      maxPdfPages: integerSetting(env, 'MAX_PDF_PAGES', DEFAULTS.maxPdfPages, DEFAULTS.maxPdfPages),
      maxImagePixels: integerSetting(env, 'MAX_IMAGE_PIXELS', DEFAULTS.maxImagePixels, DEFAULTS.maxImagePixels),
      processingTimeoutMs: integerSetting(env, 'PROCESSING_TIMEOUT_MS', DEFAULTS.processingTimeoutMs, DEFAULTS.processingTimeoutMs),
      maxPreprocessStdoutBytes: integerSetting(env, 'MAX_PREPROCESS_STDOUT_BYTES', DEFAULTS.maxPreprocessStdoutBytes, DEFAULTS.maxPreprocessStdoutBytes),
      maxPreprocessStderrBytes: integerSetting(env, 'MAX_PREPROCESS_STDERR_BYTES', DEFAULTS.maxPreprocessStderrBytes, DEFAULTS.maxPreprocessStderrBytes),
      maxAiResponseBytes: integerSetting(env, 'MAX_AI_RESPONSE_BYTES', DEFAULTS.maxAiResponseBytes, DEFAULTS.maxAiResponseBytes),
    }),
  });
}

module.exports = { loadConfig };
