const { ApiError } = require('../../errors/api-error');
const { DETECTED_DOCUMENT_TYPES: DETECTED_TYPES } = require('../../config/document-types');
const certificate = require('./certificate-profile');
const order = require('./placement-order-profile');

// Metadata only: do not import validators here, so validation/profile imports stay acyclic.
const PROFILES = Object.freeze({
  student_certificate: Object.freeze({
    fieldNames: certificate.FIELD_NAMES, integerFields: Object.freeze(['yearOfStudy']),
    schemaName: 'student_certificate_extraction', schema: certificate.certificateSchema,
    systemPrompt: certificate.SYSTEM_PROMPT,
    instruction: 'Extract the certificate fields from these pages, in the supplied page order.',
  }),
  placement_order: Object.freeze({
    fieldNames: order.FIELD_NAMES, integerFields: Object.freeze([]),
    schemaName: 'placement_order_extraction', schema: order.placementOrderSchema,
    systemPrompt: order.SYSTEM_PROMPT,
    instruction: 'Extract the placement order fields from these pages, in the supplied page order.',
  }),
});

function getDocumentProfile(documentType) {
  if (typeof documentType !== 'string' || !Object.hasOwn(PROFILES, documentType)) {
    throw new ApiError(422, 'unsupported_document_type', 'This document type cannot be processed.');
  }
  return PROFILES[documentType];
}

module.exports = { getDocumentProfile, DETECTED_TYPES };
