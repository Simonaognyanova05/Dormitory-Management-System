const { performance } = require('node:perf_hooks');
const { ApiError } = require('../../errors/api-error');
const { createPythonPreprocessor } = require('./python-preprocessor');
const { createVisionClient } = require('../ai/client');
const { buildExtractionResponse } = require('../ai/extraction-response');

function createDocumentProcessor(config, { prepare = createPythonPreprocessor(config), client = createVisionClient(config) } = {}) {
  return async (input, { onTiming } = {}) => {
    const started = performance.now();
    const deadlineAt = started + config.limits.processingTimeoutMs;
    const timings = { preprocessingMs: null, aiMs: null, validationMs: null, totalMs: null };
    async function measure(key, operation) {
      const before = performance.now();
      try { return await operation(); }
      finally { timings[key] = performance.now() - before; }
    }
    try {
      client.assertConfigured();
      const prepared = await measure('preprocessingMs', () => prepare(input, { signal: input.signal, deadlineAt }));
      const extraction = await measure('aiMs', () => client.extract(prepared, input.documentType, { signal: input.signal, deadlineAt }));
      const result = await measure('validationMs', () => buildExtractionResponse(input, extraction, { mock: client.mode === 'mock' }));
      if (performance.now() >= deadlineAt) {
        throw new ApiError(504, 'processing_timeout', 'The processing deadline was exceeded.', { retryable: true });
      }
      return result;
    } finally {
      timings.totalMs = performance.now() - started;
      // Optional internal observation only; never add timings to the public response.
      // A diagnostics callback must not replace a successful/failed OCR result.
      if (typeof onTiming === 'function') {
        try { onTiming(Object.freeze({ ...timings })); } catch { /* Ignore observer failures. */ }
      }
    }
  };
}

module.exports = { createDocumentProcessor };
