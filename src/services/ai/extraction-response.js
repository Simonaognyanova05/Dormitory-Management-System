const { ApiError } = require('../../errors/api-error');
const { validateAiExtraction } = require('../../validators/ai-extraction');
const { normalizeCertificateFields } = require('../../validators/certificate-fields');
const { normalizePlacementOrderFields } = require('../../validators/placement-order-fields');
const { getDocumentProfile } = require('./document-profiles');

function buildExtractionResponse(input, raw, { mock = false } = {}) {
  getDocumentProfile(input.documentType);
  const extraction = validateAiExtraction(raw, input.documentType);
  if (extraction.detectedDocumentType === 'medical') {
    throw new ApiError(422, 'unsupported_document_type', 'This document type cannot be processed.');
  }
  if (!extraction.readable) {
    throw new ApiError(422, 'unreadable_document', 'No readable text was found. Use a clearer document or manual entry.');
  }
  const normalize = input.documentType === 'student_certificate' ? normalizeCertificateFields : normalizePlacementOrderFields;
  const { fields, fieldIssues } = normalize(extraction.fields, extraction.uncertainFields);
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
