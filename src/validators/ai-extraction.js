const { ApiError } = require('../errors/api-error');
const { FIELD_NAMES, DETECTED_TYPES } = require('../services/ai/certificate-profile');

function badAiResponse() {
  return new ApiError(502, 'provider_bad_response', 'AI returned an invalid extraction response.', { retryable: true });
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validateAiExtraction(value) {
  if (!exactKeys(value, ['readable', 'detectedDocumentType', 'fields', 'uncertainFields'])
    || typeof value.readable !== 'boolean' || !DETECTED_TYPES.includes(value.detectedDocumentType)
    || !exactKeys(value.fields, FIELD_NAMES) || !Array.isArray(value.uncertainFields)
    || value.uncertainFields.length > FIELD_NAMES.length
    || !value.uncertainFields.every((field) => FIELD_NAMES.includes(field))
    || new Set(value.uncertainFields).size !== value.uncertainFields.length) {
    throw badAiResponse();
  }
  for (const field of FIELD_NAMES) {
    const candidate = value.fields[field];
    if (candidate !== null && (field === 'yearOfStudy' ? !Number.isSafeInteger(candidate) : typeof candidate !== 'string')) {
      throw badAiResponse();
    }
  }
  return value;
}

module.exports = { badAiResponse, validateAiExtraction };
