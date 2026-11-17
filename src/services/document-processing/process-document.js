const { ApiError } = require('../../errors/api-error');
const { performance } = require('node:perf_hooks');
const { createPythonPreprocessor } = require('./python-preprocessor');

function createDocumentProcessor(config) {
  const prepare = createPythonPreprocessor(config);
  return async (input) => {
    const deadlineAt = performance.now() + config.limits.processingTimeoutMs;
    const prepared = await prepare(input, { signal: input.signal, deadlineAt });
    // Task 8 will pass these pages and the remaining deadline to the AI client.
    throw new ApiError(503, 'processing_not_configured', 'Document prepared successfully, but AI extraction is not implemented yet.', {
      details: { stage: 'extraction', pageCount: prepared.pageCount },
    });
  };
}

module.exports = { createDocumentProcessor };
