const { performance } = require('node:perf_hooks');
const { ApiError } = require('../../errors/api-error');
const { createPythonPreprocessor } = require('./python-preprocessor');
const { createVisionClient } = require('../ai/client');
const { buildExtractionResponse } = require('../ai/extraction-response');

function createDocumentProcessor(config, { prepare = createPythonPreprocessor(config), client = createVisionClient(config) } = {}) {
  return async (input) => {
    const deadlineAt = performance.now() + config.limits.processingTimeoutMs;
    client.assertConfigured();
    const prepared = await prepare(input, { signal: input.signal, deadlineAt });
    const extraction = await client.extract(prepared, input.documentType, { signal: input.signal, deadlineAt });
    const result = buildExtractionResponse(input, extraction, { mock: client.mode === 'mock' });
    if (performance.now() >= deadlineAt) {
      throw new ApiError(504, 'processing_timeout', 'The processing deadline was exceeded.', { retryable: true });
    }
    return result;
  };
}

module.exports = { createDocumentProcessor };
