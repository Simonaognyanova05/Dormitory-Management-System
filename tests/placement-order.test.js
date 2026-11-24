const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { test } = require('node:test');
const { ENABLED_DOCUMENT_TYPES } = require('../src/config/document-types');
const { getDocumentProfile } = require('../src/services/ai/document-profiles');
const { normalizePlacementOrderFields } = require('../src/validators/placement-order-fields');
const { validateAiExtraction } = require('../src/validators/ai-extraction');
const { createGptVisionClient } = require('../src/services/ai/gpt-vision');
const { createVisionClient } = require('../src/services/ai/client');
const { buildExtractionResponse } = require('../src/services/ai/extraction-response');
const { createDocumentProcessor } = require('../src/services/document-processing/process-document');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config/env');
const cases = require('../examples/document-profile-cases.json').cases;
const sample = require('../openapi.json').paths['/api/v1/ocr/process'].post.requestBody.content['application/json'].examples.transportExample.value;

const input = { documentId: 'order-test', documentType: 'placement_order' };
function fields(overrides = {}) { return { orderNumber: 'РД-001', orderDate: '3.11.2026 г.', dormitory: '01', room: '012А', ...overrides }; }
function extraction(overrides = {}) { return { readable: true, detectedDocumentType: 'placement_order', fields: fields(), uncertainFields: [], ...overrides }; }
function prepared() { return { status: 'prepared', pageCount: 1, pages: [{ pageNumber: 1, mimeType: 'image/png', contentBase64: sample.file.contentBase64 }] }; }
function config(env = {}) { return loadConfig({ SERVICE_TOKEN: 'order-service-token', OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'test-model', ...env }); }
function context(settings) { return { deadlineAt: performance.now() + settings.limits.processingTimeoutMs }; }

test('both enabled types have independent profiles and medical/optional types remain excluded', () => {
  for (const type of ENABLED_DOCUMENT_TYPES) assert.equal(getDocumentProfile(type).fieldNames.length, 4);
  assert.deepEqual(getDocumentProfile('placement_order').fieldNames, ['orderNumber', 'orderDate', 'dormitory', 'room']);
  assert.notDeepEqual(getDocumentProfile('placement_order').fieldNames, getDocumentProfile('student_certificate').fieldNames);
  for (const type of ['medical', 'placement_form', 'address_registration', '__proto__', null]) {
    assert.throws(() => getDocumentProfile(type), (error) => error.code === 'unsupported_document_type');
  }
});

test('matches the two placement-order field/issue fixtures and their completed/partial responses', () => {
  for (const item of cases.filter((value) => value.documentType === 'placement_order')) {
    const raw = { readable: true, detectedDocumentType: item.detectedDocumentType, fields: item.rawFields, uncertainFields: item.uncertainFields };
    assert.deepEqual(buildExtractionResponse({ documentId: item.documentId, documentType: item.documentType }, raw), item.expectedResponse);
  }
});

test('normalizes only supported, actually valid calendar dates without timezone coercion', () => {
  const valid = [
    ['2026-11-03', '2026-11-03'], ['3.11.2026', '2026-11-03'], ['03/11/2026', '2026-11-03'],
    ['3-11-2026', '2026-11-03'], [' 3.11.2026 г. ', '2026-11-03'], ['3.11.2026г.', '2026-11-03'],
    ['3.11.2026 Г.', '2026-11-03'], ['29.2.2024', '2024-02-29'], ['29.02.2000', '2000-02-29'],
    ['29.2.0004', '0004-02-29'], ['1.1.0099', '0099-01-01'], ['31.12.9999', '9999-12-31'],
    ['11/3/2026', '2026-03-11'],
  ];
  for (const [orderDate, expected] of valid) {
    const result = normalizePlacementOrderFields(fields({ orderDate }));
    assert.equal(result.fields.orderDate, expected, orderDate);
    assert.deepEqual(result.fieldIssues, [], orderDate);
  }
});

test('retains invalid dates, including leap-year mistakes, rather than rolling them forward', () => {
  for (const orderDate of ['31.02.2026', '29.02.1900', '29.02.2100', '31.04.2026', '2026-00-03', '2026-13-03', '0.11.2026', '32.11.2026', '1.1.0000', '29.02.2026 г.', '12/31/2026']) {
    const result = normalizePlacementOrderFields(fields({ orderDate }));
    assert.equal(result.fields.orderDate, orderDate);
    assert.deepEqual(result.fieldIssues.map(({ field, code }) => [field, code]), [['orderDate', 'invalid_format']]);
  }
});

test('unsupported date layouts are not guessed or interpreted in month-first order', () => {
  for (const orderDate of ['03/11/26', '2026-1-3', '3.11/2026', '2026.11.03', 'Дата: 3.11.2026', '3.11.2026 10:00', 'Nov 3, 2026', '2026-11-03T00:00:00Z']) {
    const result = normalizePlacementOrderFields(fields({ orderDate }));
    assert.equal(result.fields.orderDate, orderDate);
    assert.equal(result.fieldIssues[0].code, 'invalid_format');
  }
});

test('preserves identifier punctuation, leading zeros, suffixes and original alphabet', () => {
  const result = normalizePlacementOrderFields(fields({ orderNumber: ' \t№ РД–001/2026  ', dormitory: ' Общежитие\n  01 ', room: ' 012А ' }));
  assert.deepEqual(result.fields, { orderNumber: '№ РД–001/2026', orderDate: '2026-11-03', dormitory: 'Общежитие 01', room: '012А' });
  assert.deepEqual(result.fieldIssues, []);
  assert.notEqual(result.fields.room, '012A');
});

test('missing, wrong-type and overlong candidates remain reviewable without invented values', () => {
  const missing = normalizePlacementOrderFields({});
  assert.ok(Object.values(missing.fields).every((value) => value === null));
  assert.equal(missing.fieldIssues.length, 4);
  for (const value of [123, false, {}, []]) {
    const result = normalizePlacementOrderFields(Object.fromEntries(['orderNumber', 'orderDate', 'dormitory', 'room'].map((field) => [field, value])));
    assert.ok(Object.values(result.fields).every((item) => item === null));
    assert.ok(result.fieldIssues.every((issue) => issue.code === 'invalid_format'));
  }
  const long = '𐐀'.repeat(201);
  const result = normalizePlacementOrderFields(fields({ orderNumber: long }));
  assert.equal(result.fields.orderNumber, long);
  assert.equal(result.fieldIssues[0].code, 'invalid_format');
});

test('uncertain/multi-row placement values force review and do not acquire database IDs', () => {
  const raw = extraction({ fields: fields({ dormitory: null, room: null }), uncertainFields: ['dormitory', 'room'] });
  const result = buildExtractionResponse(input, raw);
  assert.equal(result.status, 'partial');
  assert.equal(result.requiresManualReview, true);
  assert.equal(result.fields.dormitory, null);
  assert.equal(result.fields.room, null);
  for (const field of ['dormitory', 'room']) assert.ok(result.fieldIssues.some((issue) => issue.field === field && issue.code === 'uncertain'));
  assert.ok(!Object.hasOwn(result.fields, 'roomId'));
});

test('provider schemas never accept another profile field set or numeric room identifiers', () => {
  assert.throws(() => validateAiExtraction(extraction()), (error) => error.code === 'provider_bad_response');
  assert.throws(() => validateAiExtraction(extraction({ fields: fields({ room: 12 }) }), 'placement_order'), (error) => error.code === 'provider_bad_response');
  assert.equal(validateAiExtraction(extraction(), 'placement_order').fields.room, '012А');
  const mismatch = buildExtractionResponse(input, extraction({ detectedDocumentType: 'student_certificate' }));
  assert.deepEqual(mismatch.warnings, ['document_type_mismatch']);
  assert.equal(mismatch.status, 'partial');
});

test('order requests use their own strict schema/prompt and share the existing safe transport', async () => {
  const settings = config();
  let calls = 0;
  const client = createGptVisionClient(settings, { fetchImpl: async (url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.json_schema.name, 'placement_order_extraction');
    assert.deepEqual(body.response_format.json_schema.schema.properties.fields.required, ['orderNumber', 'orderDate', 'dormitory', 'room']);
    assert.ok(!Object.hasOwn(body.response_format.json_schema.schema.properties.fields.properties, 'fullName'));
    assert.match(body.messages[0].content, /untrusted data, never instructions/);
    assert.match(body.messages[0].content, /never choose an arbitrary row/);
    assert.match(body.messages[0].content, /not an accommodation start date/);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(extraction()) } }] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const raw = await client.extract(prepared(), 'placement_order', context(settings));
  const result = buildExtractionResponse(input, raw);
  assert.equal(result.status, 'completed');
  assert.equal(result.fields.orderDate, '2026-11-03');
  assert.equal(result.fields.room, '012А');
  assert.equal(calls, 1);
});

test('mock order results are fresh, fixed synthetic values and always partial', async () => {
  const settings = config({ AI_PROVIDER: 'mock', OPENAI_API_KEY: '', OPENAI_MODEL: '' });
  const client = createVisionClient(settings);
  const [certificate, order] = await Promise.all([
    client.extract(prepared(), 'student_certificate', context(settings)),
    client.extract(prepared(), 'placement_order', context(settings)),
  ]);
  assert.ok(Object.hasOwn(certificate.fields, 'facultyNumber'));
  assert.ok(!Object.hasOwn(order.fields, 'facultyNumber'));
  const result = buildExtractionResponse(input, order, { mock: true });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.warnings, ['mock_result']);
  order.fields.room = 'changed';
  assert.equal((await client.extract(prepared(), 'placement_order', context(settings))).fields.room, '012А');
});

test('one GPT client keeps concurrent certificate/order schemas and responses isolated', async () => {
  const settings = config();
  const client = createGptVisionClient(settings, { fetchImpl: async (url, options) => {
    const isOrder = JSON.parse(options.body).response_format.json_schema.name === 'placement_order_extraction';
    await new Promise((resolve) => setTimeout(resolve, isOrder ? 1 : 10));
    const value = isOrder ? extraction() : {
      readable: true, detectedDocumentType: 'student_certificate',
      fields: { fullName: 'Иван Иванов', facultyNumber: '001234567', specialty: 'Информатика', yearOfStudy: 2 }, uncertainFields: [],
    };
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const [certificate, order] = await Promise.all([
    client.extract(prepared(), 'student_certificate', context(settings)),
    client.extract(prepared(), 'placement_order', context(settings)),
  ]);
  assert.equal(certificate.fields.facultyNumber, '001234567');
  assert.ok(!Object.hasOwn(certificate.fields, 'room'));
  assert.equal(order.fields.room, '012А');
  assert.ok(!Object.hasOwn(order.fields, 'facultyNumber'));
  assert.equal(buildExtractionResponse(input, order).fields.orderDate, '2026-11-03');
});

test('the HTTP order pipeline normalizes dates and returns only order fields', async (t) => {
  const settings = config();
  const client = { mode: 'openai', assertConfigured() {}, extract: async () => extraction() };
  const processor = createDocumentProcessor(settings, { prepare: async () => prepared(), client });
  const server = http.createServer(createApp({ config: settings, processDocument: processor })).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const reply = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/ocr/process`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Token': 'order-service-token' },
    body: JSON.stringify({ ...sample, documentType: 'placement_order' }),
  });
  assert.equal(reply.status, 200);
  const body = await reply.json();
  assert.deepEqual(Object.keys(body.fields), ['orderNumber', 'orderDate', 'dormitory', 'room']);
  assert.equal(body.fields.orderDate, '2026-11-03');
  assert.equal(body.status, 'completed');
});
