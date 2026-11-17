const { ApiError } = require('../../errors/api-error');
const { validateAiExtraction } = require('../../validators/ai-extraction');
const { FIELD_NAMES } = require('./certificate-profile');

function buildExtractionResponse(input, raw, { mock = false } = {}) {
  const extraction = validateAiExtraction(raw);
  if (extraction.detectedDocumentType === 'medical') {
    throw new ApiError(422, 'unsupported_document_type', 'This document type cannot be processed.');
  }
  if (!extraction.readable) {
    throw new ApiError(422, 'unreadable_document', 'No readable text was found. Use a clearer document or manual entry.');
  }
  const fields = {};
  const fieldIssues = [];
  for (const field of FIELD_NAMES) {
    const value = extraction.fields[field];
    fields[field] = typeof value === 'string' && !value.trim() ? null : value;
    if (extraction.uncertainFields.includes(field)) {
      fieldIssues.push({ field, code: 'uncertain', message: 'This field could not be read reliably. Check the original.' });
    } else if (fields[field] === null) {
      fieldIssues.push({ field, code: 'missing', message: 'This field was not found. Enter it manually.' });
    }
  }
  // Task 9 adds semantic field rules. Never label unchecked values as completed.
  const warnings = ['field_validation_pending'];
  if (mock) warnings.unshift('mock_result');
  if (extraction.detectedDocumentType !== input.documentType) warnings.push('document_type_mismatch');
  return {
    documentId: input.documentId, documentType: input.documentType,
    detectedDocumentType: extraction.detectedDocumentType,
    status: 'partial', fields, fieldIssues, warnings, requiresManualReview: true,
  };
}

module.exports = { buildExtractionResponse };
