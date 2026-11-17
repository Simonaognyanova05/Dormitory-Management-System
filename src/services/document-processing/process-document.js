const { performance } = require('node:perf_hooks');
const { createPythonPreprocessor } = require('./python-preprocessor');
const { createVisionClient } = require('../ai/client');
const { buildExtractionResponse } = require('../ai/extraction-response');

function createDocumentProcessor(config, { prepare = createPythonPreprocessor(config), client = createVisionClient(config) } = {}) {
  return async (input) => {
    const deadlineAt = performance.now() + config.limits.processingTimeoutMs;
    client.assertConfigured();
    const prepared = await prepare(input, { signal: input.signal, deadlineAt });
    const extraction = await client.extract(prepared, input.documentType, { signal: input.signal, deadlineAt });
    return buildExtractionResponse(input, extraction, { mock: client.mode === 'mock' });
  };
}

module.exports = { createDocumentProcessor };
