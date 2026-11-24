const { FIELD_NAMES } = require('../services/ai/placement-order-profile');
const { normalizeProfileFields } = require('./profile-fields');

const LABELS = Object.freeze({ orderNumber: 'Order number', orderDate: 'Order date', dormitory: 'Dormitory', room: 'Room' });

function normalizeDate(value) {
  const text = value.replace(/\s*г\.$/iu, '').trim();
  const iso = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u.exec(text);
  const dayFirst = /^([0-9]{1,2})([./-])([0-9]{1,2})\2([0-9]{4})$/u.exec(text);
  if (!iso && !dayFirst) {
    return { value, code: 'invalid_format', message: 'Order date must use YYYY-MM-DD or a supported day-first format. Check the original.' };
  }
  const year = Number(iso ? iso[1] : dayFirst[4]);
  const month = Number(iso ? iso[2] : dayFirst[3]);
  const day = Number(iso ? iso[3] : dayFirst[1]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    return { value, code: 'invalid_format', message: 'Order date is not a valid calendar date. Check the original.' };
  }
  // Use date components, not Date.parse/UTC constructors: no locale, timezone or year-0..99 coercion.
  return { value: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

function normalizeField(field, candidate) {
  if (candidate === undefined || candidate === null || (typeof candidate === 'string' && !candidate.trim())) {
    return { value: null, code: 'missing', message: `${LABELS[field]} was not found. Enter it manually.` };
  }
  if (typeof candidate !== 'string') {
    return { value: null, code: 'invalid_format', message: `${LABELS[field]} must be a string. Check the original.` };
  }
  let value = candidate.normalize('NFC').trim();
  if (field !== 'orderDate') value = value.replace(/\s+/gu, ' ');
  if ([...value].length > 200) {
    return { value, code: 'invalid_format', message: `${LABELS[field]} exceeds 200 characters. Check the original.` };
  }
  return field === 'orderDate' ? normalizeDate(value) : { value };
}

function normalizePlacementOrderFields(rawFields, uncertainFields = []) {
  return normalizeProfileFields(rawFields, uncertainFields, FIELD_NAMES, LABELS, normalizeField);
}

module.exports = { normalizePlacementOrderFields };
