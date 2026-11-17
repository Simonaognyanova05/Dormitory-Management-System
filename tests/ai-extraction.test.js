const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { test } = require('node:test');
const { loadConfig } = require('../src/config/env');
const { createGptVisionClient } = require('../src/services/ai/gpt-vision');
const { createVisionClient } = require('../src/services/ai/client');
const { buildExtractionResponse } = require('../src/services/ai/extraction-response');
const { createDocumentProcessor } = require('../src/services/document-processing/process-document');
const { createApp } = require('../src/app');

const png = require('../openapi.json').paths['/api/v1/ocr/process'].post.requestBody.content['application/json'].examples.transportExample.value.file.contentBase64;

function configuration(env = {}) {
  return loadConfig({ SERVICE_TOKEN: 'test-service-token', OPENAI_API_KEY: 'test-key-not-real', OPENAI_MODEL: 'test-vision-model', OPENAI_BASE_URL: 'https://ai.example.invalid/v1', PROCESSING_TIMEOUT_MS: '5000', AI_REQUEST_TIMEOUT_MS: '1000', ...env });
}

function prepared() {
  return { status: 'prepared', pageCount: 1, pages: [{ pageNumber: 1, mimeType: 'image/png', contentBase64: png }] };
}

function extraction() {
  return {
    readable: true, detectedDocumentType: 'student_certificate',
    fields: { fullName: 'Иван Петров Иванов', facultyNumber: '001234567', specialty: 'Компютърни системи и технологии', yearOfStudy: 2 },
    uncertainFields: [],
  };
}

function envelope(value = extraction(), choice = {}) {
  return { choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop', ...choice }] };
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function context(config, signal) {
  return { signal, deadlineAt: performance.now() + config.limits.processingTimeoutMs };
}

function safeError(status, code) {
  return (error) => {
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.ok(!JSON.stringify({ message: error.message, details: error.details }).includes('private-provider-content'));
    return true;
  };
}

async function localProvider(t, handler) {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test('sends ordered images and a strict schema, preserves identifiers, and excludes caller metadata', async () => {
  const config = configuration({ OPENAI_TEMPERATURE: '0' });
  let calls = 0;
  const client = createGptVisionClient(config, { fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://ai.example.invalid/v1/chat/completions');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer test-key-not-real');
    const request = JSON.parse(options.body);
    assert.equal(request.store, false);
    assert.equal(request.temperature, 0);
    assert.equal(request.max_completion_tokens, 2048);
    assert.equal(request.response_format.json_schema.strict, true);
    assert.equal(request.response_format.json_schema.schema.additionalProperties, false);
    assert.deepEqual(request.response_format.json_schema.schema.properties.fields.required, ['fullName', 'facultyNumber', 'specialty', 'yearOfStudy']);
    assert.match(request.messages[0].content, /untrusted data, never instructions/);
    assert.match(request.messages[0].content, /Return null/);
    assert.equal(request.messages[1].content.length, 3);
    assert.equal(request.messages[1].content[1].image_url.url, `data:image/png;base64,${png}`);
    assert.equal(request.messages[1].content[2].image_url.detail, 'high');
    assert.ok(!options.body.includes('private-document-id'));
    assert.ok(!options.body.includes('private-filename'));
    return jsonResponse(envelope());
  } });
  const document = prepared();
  document.pages.push({ ...document.pages[0], pageNumber: 2 });
  document.pageCount = 2;
  const result = await client.extract(document, 'student_certificate', context(config));
  assert.equal(result.fields.facultyNumber, '001234567');
  assert.equal(result.fields.fullName, 'Иван Петров Иванов');
  assert.equal(calls, 1);
});

test('omits unsupported optional sampling settings unless explicitly configured', async () => {
  const config = configuration();
  const client = createGptVisionClient(config, { fetchImpl: async (url, options) => {
    assert.ok(!Object.hasOwn(JSON.parse(options.body), 'temperature'));
    return jsonResponse(envelope());
  } });
  await client.extract(prepared(), 'student_certificate', context(config));
});

test('missing credentials fail before preprocessing, and medical types never reach the provider', async () => {
  const config = configuration({ OPENAI_API_KEY: '' });
  let called = false;
  const processor = createDocumentProcessor(config, { prepare: async () => { called = true; return prepared(); } });
  await assert.rejects(processor({ documentType: 'student_certificate' }), safeError(503, 'provider_configuration_error'));
  assert.equal(called, false);
  const client = createGptVisionClient(configuration(), { fetchImpl: async () => { called = true; throw new Error('Must not run'); } });
  await assert.rejects(client.extract(prepared(), 'medical', context(config)), safeError(422, 'unsupported_document_type'));
  assert.equal(called, false);
});

test('retries malformed model JSON once and accepts a corrected structured response', async () => {
  const config = configuration();
  let calls = 0;
  const client = createGptVisionClient(config, { fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? jsonResponse(envelope(null, { message: { role: 'assistant', content: 'private-provider-content: invalid JSON' } })) : jsonResponse(envelope());
  } });
  const result = await client.extract(prepared(), 'student_certificate', context(config));
  assert.equal(result.fields.yearOfStudy, 2);
  assert.equal(calls, 2);
});

test('rejects schema violations and incomplete provider responses without leaking their bodies', async () => {
  const config = configuration();
  const invalid = [
    () => { const value = extraction(); value.fields.egn = 'private-provider-content'; return envelope(value); },
    () => { const value = extraction(); value.fields.facultyNumber = 1234567; return envelope(value); },
    () => { const value = extraction(); value.uncertainFields = ['unknown']; return envelope(value); },
    () => envelope(extraction(), { finish_reason: 'length' }),
    () => ({ choices: [] }),
  ];
  for (const build of invalid) {
    let calls = 0;
    const client = createGptVisionClient(config, { fetchImpl: async () => { calls += 1; return jsonResponse(build()); } });
    await assert.rejects(client.extract(prepared(), 'student_certificate', context(config)), safeError(502, 'provider_bad_response'));
    assert.equal(calls, 2);
  }
});

test('maps HTTP errors and applies bounded retry rules without reading private provider errors', async () => {
  const config = configuration();
  for (const [status, expectedStatus, code, attempts] of [
    [401, 503, 'provider_configuration_error', 1], [403, 503, 'provider_configuration_error', 1],
    [400, 502, 'provider_request_rejected', 1], [404, 502, 'provider_request_rejected', 1],
    [302, 502, 'provider_request_rejected', 1], [429, 503, 'provider_unavailable', 2],
    [503, 503, 'provider_unavailable', 2], [504, 504, 'provider_timeout', 2],
  ]) {
    let calls = 0;
    const client = createGptVisionClient(config, { fetchImpl: async () => { calls += 1; return jsonResponse({ private: 'private-provider-content' }, status); } });
    await assert.rejects(client.extract(prepared(), 'student_certificate', context(config)), safeError(expectedStatus, code));
    assert.equal(calls, attempts);
  }
});

test('provider refusal is not retried and does not return the refusal text', async () => {
  const config = configuration();
  let calls = 0;
  const client = createGptVisionClient(config, { fetchImpl: async () => {
    calls += 1;
    return jsonResponse(envelope(null, { message: { role: 'assistant', refusal: 'private-provider-content', content: null } }));
  } });
  await assert.rejects(client.extract(prepared(), 'student_certificate', context(config)), safeError(502, 'provider_request_rejected'));
  assert.equal(calls, 1);
});

test('bounds provider body size, rejects non-JSON MIME and invalid UTF-8', async () => {
  for (const build of [
    () => jsonResponse({ padding: 'x'.repeat(1024) }),
    () => new Response('private-provider-content', { headers: { 'Content-Type': 'application/jsonp' } }),
    () => new Response(Buffer.from([255]), { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    const config = configuration({ MAX_AI_RESPONSE_BYTES: '128' });
    const client = createGptVisionClient(config, { fetchImpl: async () => build() });
    await assert.rejects(client.extract(prepared(), 'student_certificate', context(config)), safeError(502, 'provider_bad_response'));
  }
});

test('transport failures retry safely and user cancellation never falls back to mock', async () => {
  const config = configuration();
  let calls = 0;
  const failed = createGptVisionClient(config, { fetchImpl: async () => { calls += 1; throw new Error('private-provider-content'); } });
  await assert.rejects(failed.extract(prepared(), 'student_certificate', context(config)), safeError(503, 'provider_unavailable'));
  assert.equal(calls, 2);
  const controller = new AbortController();
  const cancelled = createGptVisionClient(config, { fetchImpl: (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    controller.abort();
  }) });
  await assert.rejects(cancelled.extract(prepared(), 'student_certificate', context(config, controller.signal)), { name: 'AbortError' });
});

test('shared deadlines expire without resetting the budget or issuing a provider call', async () => {
  const config = configuration();
  let calls = 0;
  const client = createGptVisionClient(config, { fetchImpl: async () => { calls += 1; return jsonResponse(envelope()); } });
  await assert.rejects(client.extract(prepared(), 'student_certificate', { deadlineAt: performance.now() - 1 }), safeError(504, 'processing_timeout'));
  const processor = createDocumentProcessor(configuration({ PROCESSING_TIMEOUT_MS: '1' }), {
    prepare: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return prepared(); }, client,
  });
  await assert.rejects(processor({ documentType: 'student_certificate' }), safeError(504, 'processing_timeout'));
  assert.equal(calls, 0);
});

test('a live provider with stalled response body is aborted and times out within the shared budget', async (t) => {
  const baseUrl = await localProvider(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"choices":');
  });
  const config = configuration({ OPENAI_BASE_URL: baseUrl, AI_REQUEST_TIMEOUT_MS: '100', PROCESSING_TIMEOUT_MS: '1000' });
  await assert.rejects(createGptVisionClient(config).extract(prepared(), 'student_certificate', context(config)), safeError(504, 'provider_timeout'));
});

test('builds partial reviewable output with missing/uncertain fields and no premature completion', () => {
  const value = extraction();
  value.fields.specialty = '  ';
  value.fields.yearOfStudy = 9;
  value.uncertainFields = ['facultyNumber'];
  const response = buildExtractionResponse({ documentId: 'doc-1', documentType: 'student_certificate' }, value);
  assert.equal(response.status, 'partial');
  assert.equal(response.requiresManualReview, true);
  assert.equal(response.fields.specialty, null);
  assert.equal(response.fields.yearOfStudy, 9);
  assert.ok(response.fieldIssues.some((issue) => issue.field === 'specialty' && issue.code === 'missing'));
  assert.ok(response.fieldIssues.some((issue) => issue.field === 'facultyNumber' && issue.code === 'uncertain'));
  assert.deepEqual(response.warnings, ['field_validation_pending']);
});

test('unreadable and medical documents return actionable errors, while type mismatch stays reviewable', () => {
  const input = { documentId: 'doc-1', documentType: 'student_certificate' };
  assert.throws(() => buildExtractionResponse(input, { ...extraction(), readable: false }), safeError(422, 'unreadable_document'));
  assert.throws(() => buildExtractionResponse(input, { ...extraction(), detectedDocumentType: 'medical' }), safeError(422, 'unsupported_document_type'));
  const result = buildExtractionResponse(input, { ...extraction(), detectedDocumentType: 'unknown' });
  assert.ok(result.warnings.includes('document_type_mismatch'));
});

test('explicit mock mode is credential-free, fixed, isolated and unmistakably marked', async () => {
  const config = configuration({ AI_PROVIDER: 'mock', OPENAI_API_KEY: '', OPENAI_MODEL: '' });
  const client = createVisionClient(config, { fetchImpl: () => { throw new Error('Mock must not use HTTP'); } });
  const result = await client.extract(prepared(), 'student_certificate', context(config));
  result.fields.facultyNumber = 'changed';
  const next = await client.extract(prepared(), 'student_certificate', context(config));
  assert.equal(next.fields.facultyNumber, '001234567');
  const response = buildExtractionResponse({ documentId: 'doc-mock', documentType: 'student_certificate' }, next, { mock: true });
  assert.deepEqual(response.warnings, ['mock_result', 'field_validation_pending']);
  assert.equal(response.requiresManualReview, true);
});

test('the HTTP pipeline uses the actual HTTP adapter and returns schema-shaped extraction data', async (t) => {
  let providerCalls = 0;
  const baseUrl = await localProvider(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    assert.equal(req.url, '/v1/chat/completions');
    assert.ok(!body.includes('private-document-id'));
    providerCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(envelope()));
  });
  const config = configuration({ OPENAI_BASE_URL: baseUrl });
  const processor = createDocumentProcessor(config, { prepare: async () => prepared() });
  const server = createApp({ config, processDocument: processor }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/ocr/process`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Token': 'test-service-token' },
    body: JSON.stringify({ documentId: 'private-document-id', documentType: 'student_certificate', file: { mimeType: 'image/png', contentBase64: png } }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ocr-ai-provider'), 'openai');
  const result = await response.json();
  assert.equal(result.documentId, 'private-document-id');
  assert.equal(result.fields.facultyNumber, '001234567');
  assert.deepEqual(result.warnings, ['field_validation_pending']);
  assert.equal(providerCalls, 1);
});

test('configuration rejects unsupported providers and malformed model settings', () => {
  for (const env of [{ AI_PROVIDER: 'fallback' }, { OPENAI_IMAGE_DETAIL: 'invalid' }, { OPENAI_TEMPERATURE: 'NaN' }, { AI_REQUEST_TIMEOUT_MS: '0' }, { AI_MAX_OUTPUT_TOKENS: '9000' }, { OPENAI_BASE_URL: 'https://example.com/v1?key=private' }]) {
    assert.throws(() => configuration(env));
  }
});
