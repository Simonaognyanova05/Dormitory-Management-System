const { badAiResponse } = require('./ai-extraction');

function normalizeProfileFields(rawFields, uncertainFields, fieldNames, labels, normalizeField) {
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields) || !Array.isArray(uncertainFields)) {
    throw badAiResponse();
  }
  const uncertain = new Set(uncertainFields.filter((field) => fieldNames.includes(field)));
  const fields = {};
  const fieldIssues = [];
  for (const field of fieldNames) {
    const candidate = Object.hasOwn(rawFields, field) ? rawFields[field] : undefined;
    const normalized = normalizeField(field, candidate);
    fields[field] = normalized.value;
    if (normalized.code) fieldIssues.push({ field, code: normalized.code, message: normalized.message });
    if (uncertain.has(field)) {
      fieldIssues.push({ field, code: 'uncertain', message: `${labels[field]} could not be read reliably. Check the original.` });
    }
  }
  return { fields, fieldIssues };
}

module.exports = { normalizeProfileFields };
