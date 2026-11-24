const { FIELD_NAMES } = require('../services/ai/certificate-profile');
const { normalizeProfileFields } = require('./profile-fields');

const LABELS = Object.freeze({ fullName: 'Full name', facultyNumber: 'Faculty number', specialty: 'Specialty', yearOfStudy: 'Year of study' });
const ROMAN_YEARS = Object.freeze({ I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 });

function invalidYear() {
  return { value: null, code: 'invalid_format', message: 'Year of study must be a whole number from 1 to 6. Check the original.' };
}

function normalizeYear(value) {
  let normalized = value;
  if (typeof value === 'string') {
    const text = value.normalize('NFC').trim();
    if ([...text].length > 200) return invalidYear();
    if (/^[IViv]+$/u.test(text) && Object.hasOwn(ROMAN_YEARS, text.toUpperCase())) normalized = ROMAN_YEARS[text.toUpperCase()];
    else if (/^[+-]?[0-9]+$/.test(text)) normalized = Number(text);
    else return invalidYear();
  }
  if (!Number.isSafeInteger(normalized)) return invalidYear();
  if (normalized < 1 || normalized > 6) {
    return { value: normalized, code: 'invalid_format', message: 'Year of study must be between 1 and 6. Review the document.' };
  }
  return { value: normalized };
}

function normalizeField(field, candidate) {
  if (candidate === undefined || candidate === null || (typeof candidate === 'string' && !candidate.trim())) {
    return { value: null, code: 'missing', message: `${LABELS[field]} was not found. Enter it manually.` };
  }
  if (field === 'yearOfStudy') return normalizeYear(candidate);
  if (typeof candidate !== 'string') {
    const message = field === 'facultyNumber'
      ? 'Faculty number must be a string. Check the original to preserve leading zeros.'
      : `${LABELS[field]} must be a string. Check the original.`;
    return { value: null, code: 'invalid_format', message };
  }

  let value = candidate.normalize('NFC').trim();
  if (field !== 'facultyNumber') value = value.replace(/\s+/gu, ' ');
  if (field === 'facultyNumber') {
    if (!/^[\p{L}0-9]{5,12}$/u.test(value)) {
      return { value, code: 'invalid_format', message: 'Faculty number must contain 5 to 12 letters or digits without separators. Check the original.' };
    }
  } else if ([...value].length > 200) {
    return { value, code: 'invalid_format', message: `${LABELS[field]} exceeds 200 characters. Check the original.` };
  }
  return { value };
}

function normalizeCertificateFields(rawFields, uncertainFields = []) {
  return normalizeProfileFields(rawFields, uncertainFields, FIELD_NAMES, LABELS, normalizeField);
}

module.exports = { normalizeCertificateFields };
