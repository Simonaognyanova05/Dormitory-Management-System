const { ApiError } = require('../../errors/api-error');

async function processDocument() {
  // Replaced by Python preprocessing and AI extraction in subsequent tasks.
  // Do not return a fabricated OCR success for a file that has only been validated.
  throw new ApiError(503, 'processing_not_configured', 'Request and file are valid, but OCR processing is not implemented yet.');
}

module.exports = { processDocument };
