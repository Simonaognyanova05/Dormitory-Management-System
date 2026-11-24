const { ApiError } = require('../errors/api-error');
const { getDocumentProfile, DETECTED_TYPES } = require('../services/ai/document-profiles');

function badAiResponse() {
  return new ApiError(502, 'provider_bad_response', 'AI returned an invalid extraction response.', { retryable: true });
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validateAiExtraction(value, documentType = 'student_certificate') {
  const { fieldNames, integerFields } = getDocumentProfile(documentType);
  if (!exactKeys(value, ['readable', 'detectedDocumentType', 'fields', 'uncertainFields'])
    || typeof value.readable !== 'boolean' || !DETECTED_TYPES.includes(value.detectedDocumentType)
    || !exactKeys(value.fields, fieldNames) || !Array.isArray(value.uncertainFields)
    || value.uncertainFields.length > fieldNames.length
    || !value.uncertainFields.every((field) => fieldNames.includes(field))
    || new Set(value.uncertainFields).size !== value.uncertainFields.length) {
    throw badAiResponse();
  }
  for (const field of fieldNames) {
    const candidate = value.fields[field];
    if (candidate !== null && (integerFields.includes(field) ? !Number.isSafeInteger(candidate) : typeof candidate !== 'string')) {
      throw badAiResponse();
    }
  }
  return value;
}

module.exports = { badAiResponse, validateAiExtraction };
