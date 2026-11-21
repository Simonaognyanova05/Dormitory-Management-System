const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeCertificateFields } = require('../src/validators/certificate-fields');
const { buildExtractionResponse } = require('../src/services/ai/extraction-response');
const { validateAiExtraction } = require('../src/validators/ai-extraction');
const cases = require('../examples/document-profile-cases.json').cases;

function fields(overrides = {}) {
  return { fullName: 'Иван Петров Иванов', facultyNumber: '001234567', specialty: 'Компютърни системи и технологии', yearOfStudy: 2, ...overrides };
}

function extraction(overrides = {}) {
  return { readable: true, detectedDocumentType: 'student_certificate', fields: fields(), uncertainFields: [], ...overrides };
}

const input = { documentId: 'certificate-test', documentType: 'student_certificate' };

test('matches all six certificate field/issue fixtures without changing their input', () => {
  for (const item of cases.filter((value) => value.documentType === 'student_certificate')) {
    const before = JSON.stringify(item);
    const result = normalizeCertificateFields(item.rawFields, item.uncertainFields);
    assert.deepEqual(result.fields, item.expectedResponse.fields, item.id);
    assert.deepEqual(result.fieldIssues, item.expectedResponse.fieldIssues, item.id);
    assert.equal(JSON.stringify(item), before);
  }
});

test('normalizes NFC and whitespace while preserving alphabet, case, punctuation and zeros', () => {
  const result = normalizeCertificateFields(fields({
    fullName: '  И\u0306ордан\tO’Neil-Петров\n ',
    facultyNumber: '\t AbC00123 \n',
    specialty: '  Софтуерно\u00a0  инженерство\nи технологии ',
  }));
  assert.equal(result.fields.fullName, 'Йордан O’Neil-Петров');
  assert.equal(result.fields.facultyNumber, 'AbC00123');
  assert.equal(result.fields.specialty, 'Софтуерно инженерство и технологии');
  assert.deepEqual(result.fieldIssues, []);
});

test('counts Unicode code points and never truncates overlong text', () => {
  const valid = '𐐀'.repeat(200);
  const invalid = `${valid}𐐀`;
  assert.deepEqual(normalizeCertificateFields(fields({ fullName: valid })).fieldIssues, []);
  const result = normalizeCertificateFields(fields({ fullName: invalid, specialty: 'S'.repeat(201) }));
  assert.equal(result.fields.fullName, invalid);
  assert.equal(result.fields.specialty.length, 201);
  assert.deepEqual(result.fieldIssues.map(({ field, code }) => [field, code]), [['fullName', 'invalid_format'], ['specialty', 'invalid_format']]);
  assert.deepEqual(normalizeCertificateFields(fields({ fullName: '李' })).fieldIssues, []);
});

test('faculty identifiers obey the 5-12 Unicode-letter/ASCII-digit rule', () => {
  for (const facultyNumber of ['00001', '123456789012', 'АБ00123', 'aBc0012', '𝔄'.repeat(12)]) {
    assert.deepEqual(normalizeCertificateFields(fields({ facultyNumber })).fieldIssues, [], facultyNumber);
  }
  for (const facultyNumber of ['1234', '1234567890123', '123 456', '12-345', '12_345', '１２３４５', '١٢٣٤٥']) {
    const result = normalizeCertificateFields(fields({ facultyNumber }));
    assert.equal(result.fields.facultyNumber, facultyNumber);
    assert.equal(result.fieldIssues[0].field, 'facultyNumber');
    assert.equal(result.fieldIssues[0].code, 'invalid_format');
  }
});

test('never repairs lookalike characters or removes internal faculty-number separators', () => {
  const candidate = '0012З4567';
  const result = normalizeCertificateFields(fields({ facultyNumber: candidate }), ['facultyNumber']);
  assert.equal(result.fields.facultyNumber, candidate);
  assert.equal(result.fieldIssues[0].code, 'uncertain');
  const separated = normalizeCertificateFields(fields({ facultyNumber: '001 2345' }));
  assert.equal(separated.fields.facultyNumber, '001 2345');
  assert.equal(separated.fieldIssues[0].code, 'invalid_format');
});

test('wrong text-field types become null with invalid_format rather than guessed text', () => {
  for (const value of [0, 1234567, false, true, [], {}, NaN, Infinity]) {
    const result = normalizeCertificateFields(fields({ fullName: value, facultyNumber: value, specialty: value }));
    for (const field of ['fullName', 'facultyNumber', 'specialty']) {
      assert.equal(result.fields[field], null);
      assert.ok(result.fieldIssues.some((issue) => issue.field === field && issue.code === 'invalid_format'));
    }
    assert.ok(!result.fieldIssues.some((issue) => issue.code === 'missing'));
  }
});

test('missing, null and whitespace-only values are represented for manual entry', () => {
  for (const source of [{}, fields({ fullName: null, facultyNumber: undefined, specialty: '\t\n\u00a0', yearOfStudy: ' ' })]) {
    const result = normalizeCertificateFields(source);
    assert.deepEqual(result.fields, { fullName: null, facultyNumber: null, specialty: null, yearOfStudy: null });
    assert.equal(result.fieldIssues.length, 4);
    assert.ok(result.fieldIssues.every((issue) => issue.code === 'missing'));
  }
});

test('normalizes exact integer strings and unambiguous ASCII Roman study years', () => {
  for (const [candidate, expected] of [[1, 1], [6, 6], ['1', 1], [' 2 ', 2], ['+2', 2], ['02', 2], ['I', 1], ['iii', 3], ['IV', 4], ['v', 5], ['VI', 6]]) {
    const result = normalizeCertificateFields(fields({ yearOfStudy: candidate }));
    assert.equal(result.fields.yearOfStudy, expected);
    assert.deepEqual(result.fieldIssues, []);
  }
});

test('retains safe out-of-range years but rejects fractions, booleans and unsafe conversions', () => {
  for (const candidate of [0, -1, 7, 9, Number.MAX_SAFE_INTEGER, '-2', '9']) {
    const result = normalizeCertificateFields(fields({ yearOfStudy: candidate }));
    assert.equal(result.fields.yearOfStudy, Number(candidate));
    assert.equal(result.fieldIssues[0].code, 'invalid_format');
  }
  for (const candidate of [true, false, 2.5, Infinity, NaN, [], {}, '2.0', '2e0', '2/3', 'II курс', 'Ⅱ', 'ıı', '9007199254740993', '0'.repeat(201) + '2']) {
    const result = normalizeCertificateFields(fields({ yearOfStudy: candidate }));
    assert.equal(result.fields.yearOfStudy, null);
    assert.equal(result.fieldIssues[0].code, 'invalid_format');
  }
});

test('keeps independent missing/invalid/uncertain issues without duplicates or value leaks', () => {
  const result = normalizeCertificateFields(fields({ facultyNumber: 'private-invalid-identifier', specialty: null }), ['facultyNumber', 'facultyNumber', 'specialty']);
  assert.deepEqual(result.fieldIssues.filter(({ field }) => field === 'facultyNumber').map(({ code }) => code), ['invalid_format', 'uncertain']);
  assert.deepEqual(result.fieldIssues.filter(({ field }) => field === 'specialty').map(({ code }) => code), ['missing', 'uncertain']);
  assert.ok(!JSON.stringify(result.fieldIssues).includes('private-invalid-identifier'));
});

test('only own profile fields are copied; extra and inherited data cannot become output', () => {
  const source = Object.assign(Object.create({ fullName: 'private-inherited-name' }), { facultyNumber: '001234567', specialty: 'Информатика', yearOfStudy: 2, egn: 'private-extra-data' });
  const result = normalizeCertificateFields(source, ['egn']);
  assert.equal(result.fields.fullName, null);
  assert.deepEqual(Object.keys(result.fields), ['fullName', 'facultyNumber', 'specialty', 'yearOfStudy']);
  assert.ok(!JSON.stringify(result).includes('private-extra-data'));
  assert.ok(!JSON.stringify(result).includes('private-inherited-name'));
});

test('provider schema errors remain distinct from defensive raw-candidate normalization', () => {
  const raw = extraction({ fields: fields({ facultyNumber: 1234567 }) });
  assert.throws(() => validateAiExtraction(raw), (error) => error.code === 'provider_bad_response');
  assert.equal(normalizeCertificateFields(raw.fields).fields.facultyNumber, null);
  for (const source of [null, [], false, 'text']) {
    assert.throws(() => normalizeCertificateFields(source), (error) => error.code === 'provider_bad_response');
  }
});

test('real well-formed extraction completes only after all semantic checks pass', () => {
  const response = buildExtractionResponse(input, extraction({ fields: fields({ fullName: '  Иван\tПетров Иванов  ' }) }));
  assert.equal(response.status, 'completed');
  assert.equal(response.requiresManualReview, false);
  assert.equal(response.fields.fullName, 'Иван Петров Иванов');
  assert.deepEqual(response.fieldIssues, []);
  assert.deepEqual(response.warnings, []);
});

test('invalid values, uncertainty, type mismatch and mock mode each prevent completion', () => {
  const variants = [
    [extraction({ fields: fields({ yearOfStudy: 9 }) }), {}],
    [extraction({ fields: fields({ specialty: null }) }), {}],
    [extraction({ uncertainFields: ['fullName'] }), {}],
    [extraction({ detectedDocumentType: 'unknown' }), {}],
    [extraction(), { mock: true }],
  ];
  for (const [raw, options] of variants) {
    const result = buildExtractionResponse(input, raw, options);
    assert.equal(result.status, 'partial');
    assert.equal(result.requiresManualReview, true);
    assert.ok(result.fieldIssues.length || result.warnings.length);
    assert.ok(!result.warnings.includes('field_validation_pending'));
  }
  assert.deepEqual(buildExtractionResponse(input, extraction(), { mock: true }).warnings, ['mock_result']);
});

test('a readable document without target values remains a partial manual-entry result', () => {
  const result = buildExtractionResponse(input, extraction({ fields: fields({ fullName: null, facultyNumber: null, specialty: null, yearOfStudy: null }) }));
  assert.equal(result.status, 'partial');
  assert.equal(result.fieldIssues.length, 4);
  assert.ok(result.fieldIssues.every(({ code }) => code === 'missing'));
  assert.deepEqual(result.warnings, []);
});
