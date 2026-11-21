const { ApiError } = require('../../errors/api-error');
const { validateAiExtraction } = require('../../validators/ai-extraction');
const { normalizeCertificateFields } = require('../../validators/certificate-fields');
const { requireCertificate } = require('./certificate-profile');

function buildExtractionResponse(input, raw, { mock = false } = {}) {
  requireCertificate(input.documentType);
  const extraction = validateAiExtraction(raw);
  if (extraction.detectedDocumentType === 'medical') {
    throw new ApiError(422, 'unsupported_document_type', 'This document type cannot be processed.');
  }
  if (!extraction.readable) {
    throw new ApiError(422, 'unreadable_document', 'No readable text was found. Use a clearer document or manual entry.');
  }
  const { fields, fieldIssues } = normalizeCertificateFields(extraction.fields, extraction.uncertainFields);
  const warnings = mock ? ['mock_result'] : [];
  if (extraction.detectedDocumentType !== input.documentType) warnings.push('document_type_mismatch');
  const requiresManualReview = fieldIssues.length > 0 || warnings.length > 0;
  return {
    documentId: input.documentId, documentType: input.documentType,
    detectedDocumentType: extraction.detectedDocumentType,
    status: requiresManualReview ? 'partial' : 'completed', fields, fieldIssues, warnings, requiresManualReview,
  };
}

module.exports = { buildExtractionResponse };
