const assert = require('node:assert/strict');
const { once } = require('node:events');
const { before, test } = require('node:test');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config/env');
const { validateProcessRequest } = require('../src/validators/process-request');
const openapi = require('../openapi.json');

const TOKEN = 'synthetic-test-service-token';
const fixtures = {};

before(async () => {
  const image = { create: { width: 8, height: 8, channels: 3, background: 'white' } };
  fixtures.png = await sharp(image).png().toBuffer();
  fixtures.jpeg = await sharp(image).jpeg().toBuffer();
  for (const pages of [0, 1, 3, 4]) {
    const document = await PDFDocument.create();
    for (let page = 0; page < pages; page += 1) document.addPage().drawText('SYNTHETIC TEST');
    fixtures[`pdf${pages}`] = Buffer.from(await document.save({ addDefaultPage: false }));
  }
});

function requestBody(buffer = fixtures.png, mimeType = 'image/png') {
  return {
    documentId: 'test-doc-001',
    documentType: 'student_certificate',
    file: { mimeType, contentBase64: buffer.toString('base64') },
  };
}

async function startApp(t, { env = {}, useDefaultProcessor = false } = {}) {
  const calls = [];
  const config = loadConfig({ SERVICE_TOKEN: TOKEN, ...env });
  const options = { config };
  if (!useDefaultProcessor) {
    // Test-only stand-in at the processing boundary. This performs no OCR.
    options.processDocument = async (input) => {
      calls.push(input);
      const fields = { fullName: null, facultyNumber: null, specialty: null, yearOfStudy: null };
      return {
        documentId: input.documentId,
        documentType: input.documentType,
        detectedDocumentType: 'student_certificate',
        status: 'partial',
        fields,
        fieldIssues: Object.keys(fields).map((field) => ({ field, code: 'missing', message: 'Test boundary only.' })),
        warnings: [],
        requiresManualReview: true,
      };
    };
  }
  const server = createApp(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const url = `http://127.0.0.1:${server.address().port}`;

  async function post(body, headers = {}) {
    return fetch(`${url}/api/v1/ocr/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Token': TOKEN, ...headers },
      body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
  }
  return { url, post, calls };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['error']);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'details', 'message', 'retryable']);
  assert.equal(body.error.code, code);
  assert.equal(body.error.retryable, false);
  return body;
}

test('health remains public without configured service or AI credentials', async (t) => {
  const app = await startApp(t, { env: { SERVICE_TOKEN: '' } });
  const response = await fetch(`${app.url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'dormitory-ocr' });
  await expectError(await app.post(requestBody()), 503, 'service_not_configured');
  assert.equal(app.calls.length, 0);
});

test('authentication runs before JSON parsing and body-size checks', async (t) => {
  const app = await startApp(t, { env: { MAX_FILE_BYTES: '1024', MAX_JSON_BODY_BYTES: '4096' } });
  await expectError(await app.post('{malformed', { 'X-Service-Token': '' }), 401, 'unauthorized');
  await expectError(await app.post('x'.repeat(5000), { 'X-Service-Token': 'incorrect' }), 401, 'unauthorized');
  const missing = await fetch(`${app.url}/api/v1/ocr/process`, { method: 'POST' });
  await expectError(missing, 401, 'unauthorized');
  assert.equal(app.calls.length, 0);
});

test('rejects non-JSON, compressed JSON, unsupported charset and malformed JSON safely', async (t) => {
  const app = await startApp(t);
  await expectError(await app.post(requestBody(), { 'Content-Type': 'multipart/form-data' }), 415, 'unsupported_media_type');
  await expectError(await app.post(requestBody(), { 'Content-Encoding': 'gzip' }), 415, 'unsupported_media_type');
  await expectError(await app.post(requestBody(), { 'Content-Type': 'application/json; charset=utf-16' }), 415, 'unsupported_media_type');
  const invalidUtf8 = Buffer.concat([Buffer.from('{"value":"'), Buffer.from([255]), Buffer.from('"}')]);
  await expectError(await app.post(invalidUtf8), 400, 'invalid_json');
  const invalid = await expectError(await app.post('{"sensitive":"do-not-echo",'), 400, 'invalid_json');
  assert.ok(!JSON.stringify(invalid).includes('do-not-echo'));
  assert.equal(app.calls.length, 0);
});

test('rejects invalid JSON structures, missing fields, extra fields and wrong value types', async (t) => {
  const app = await startApp(t);
  const invalid = [
    'null', '[]', '42', '"text"', {},
    { ...requestBody(), unexpected: true },
    { ...requestBody(), file: null },
    { ...requestBody(), file: { ...requestBody().file, unexpected: true } },
    { ...requestBody(), file: { ...requestBody().file, contentBase64: 123 } },
    { ...requestBody(), file: { ...requestBody().file, mimeType: 123 } },
    { ...requestBody(), documentType: null },
  ];
  for (const body of invalid) await expectError(await app.post(body), 400, 'invalid_request');
  assert.equal(app.calls.length, 0);
});

test('validates opaque identifiers without changing them', async (t) => {
  const app = await startApp(t);
  for (const documentId of ['', ' leading-space', 'trailing\n', '../file', 'x'.repeat(129), 123]) {
    await expectError(await app.post({ ...requestBody(), documentId }), 400, 'invalid_request');
  }
  for (const documentId of ['doc-123', '7c1e1234-1234-4123-8123-123456789abc']) {
    const response = await app.post({ ...requestBody(), documentId });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).documentId, documentId);
  }
  assert.equal(app.calls.length, 2);
});

test('rejects medical, unknown, legacy and not-yet-enabled types before file decoding', async (t) => {
  const app = await startApp(t);
  for (const documentType of ['medical', 'unknown', 'student_status_certificate', 'placement_order', 'placement_form', 'address_registration']) {
    await expectError(await app.post({ ...requestBody(), documentType, file: null }), 422, 'unsupported_document_type');
  }
  assert.equal(app.calls.length, 0);
});

test('rejects noncanonical Base64 including bad padding bits and data URL prefixes', async (t) => {
  const app = await startApp(t);
  const invalid = ['', '!!!!', 'TQ', 'TQ=\n', 'TR==', 'TQ===', '____', 'TQ== ', 'data:image/png;base64,TQ=='];
  for (const contentBase64 of invalid) {
    const body = requestBody();
    body.file.contentBase64 = contentBase64;
    await expectError(await app.post(body), 400, 'invalid_base64');
  }
  assert.equal(app.calls.length, 0);
});

test('the default maximum-size Base64 input does not overflow the regex stack', () => {
  const config = loadConfig({});
  const bytes = Buffer.alloc(config.limits.maxFileBytes);
  const parsed = validateProcessRequest(requestBody(bytes), config.limits);
  assert.equal(parsed.buffer.length, config.limits.maxFileBytes);
});

test('enforces JSON size before parsing and decoded size even within the Base64 length ceiling', async (t) => {
  const app = await startApp(t, { env: { MAX_FILE_BYTES: '1024', MAX_JSON_BODY_BYTES: '4096' } });
  await expectError(await app.post('x'.repeat(4097)), 413, 'payload_too_large');
  // 1024 and 1025 decoded bytes have the same Base64 length.
  await expectError(await app.post(requestBody(Buffer.alloc(1025))), 413, 'file_too_large');
  await expectError(await app.post(requestBody(Buffer.alloc(1030))), 413, 'file_too_large');
  assert.equal(app.calls.length, 0);
});

test('passes valid PNG, JPEG and one/three-page PDFs unchanged to the processing boundary', async (t) => {
  const app = await startApp(t);
  for (const [buffer, mimeType, format, pageCount] of [
    [fixtures.png, 'image/png', 'png', 1],
    [fixtures.jpeg, 'image/jpeg', 'jpeg', 1],
    [fixtures.pdf1, 'application/pdf', 'pdf', 1],
    [fixtures.pdf3, 'application/pdf', 'pdf', 3],
  ]) {
    const response = await app.post(requestBody(buffer, mimeType), { 'Content-Type': 'application/json; charset=utf-8' });
    assert.equal(response.status, 200);
    const input = app.calls.at(-1);
    assert.deepEqual(input.buffer, buffer);
    assert.equal(input.mimeType, mimeType);
    assert.equal(input.metadata.format, format);
    assert.equal(input.metadata.pageCount, pageCount);
  }
  assert.equal(app.calls.length, 4);
});

test('rejects MIME/signature mismatches and unsupported MIME types', async (t) => {
  const app = await startApp(t);
  for (const body of [
    requestBody(fixtures.png, 'image/jpeg'),
    requestBody(fixtures.jpeg, 'image/png'),
    requestBody(fixtures.png, 'application/pdf'),
    requestBody(fixtures.pdf1, 'image/png'),
    requestBody(fixtures.png, 'image/gif'),
  ]) await expectError(await app.post(body), 415, 'unsupported_file');
  assert.equal(app.calls.length, 0);
});

test('rejects corrupt PDF/image data rather than trusting signatures alone', async (t) => {
  const app = await startApp(t);
  for (const body of [
    requestBody(Buffer.from('%PDF-1.7\ncorrupt'), 'application/pdf'),
    requestBody(fixtures.png.subarray(0, 24), 'image/png'),
    requestBody(fixtures.jpeg.subarray(0, fixtures.jpeg.length - 10), 'image/jpeg'),
  ]) await expectError(await app.post(body), 415, 'unsupported_file');
  assert.equal(app.calls.length, 0);
});

test('rejects PDFs over the page limit and PDFs without pages', async (t) => {
  const app = await startApp(t);
  await expectError(await app.post(requestBody(fixtures.pdf4, 'application/pdf')), 413, 'page_limit_exceeded');
  await expectError(await app.post(requestBody(fixtures.pdf0, 'application/pdf')), 422, 'unreadable_document');
  assert.equal(app.calls.length, 0);
});

test('rejects a real password-protected PDF without calling processing', async (t) => {
  const app = await startApp(t);
  const fixture = require('./fixtures/encrypted-pdf.json');
  const buffer = Buffer.from(fixture.contentBase64, 'base64');
  await expectError(await app.post(requestBody(buffer, 'application/pdf')), 422, 'unreadable_document');
  assert.equal(app.calls.length, 0);
});

test('checks image dimensions before pixel decoding', async (t) => {
  const app = await startApp(t, { env: { MAX_IMAGE_PIXELS: '16' } });
  await expectError(await app.post(requestBody()), 413, 'file_too_large');
  assert.equal(app.calls.length, 0);
});

test('the documented Postman PNG reaches the explicit pending-pipeline response', async (t) => {
  const app = await startApp(t, { useDefaultProcessor: true });
  const example = openapi.paths['/api/v1/ocr/process'].post.requestBody.content['application/json'].examples.transportExample.value;
  const result = await expectError(await app.post(example), 503, 'processing_not_configured');
  assert.match(result.error.message, /Request and file are valid/);
});

test('unexpected processing errors do not expose exception messages', async (t) => {
  const config = loadConfig({ SERVICE_TOKEN: TOKEN });
  const server = createApp({ config, processDocument: async () => { throw new Error('do-not-expose-this-secret'); } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/ocr/process`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Token': TOKEN }, body: JSON.stringify(requestBody()),
  });
  const result = await expectError(response, 500, 'internal_error');
  assert.ok(!JSON.stringify(result).includes('do-not-expose-this-secret'));
});
