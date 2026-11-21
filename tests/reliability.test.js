const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { test } = require('node:test');
const { loadConfig } = require('../src/config/env');
const { createApp } = require('../src/app');
const { createGptVisionClient } = require('../src/services/ai/gpt-vision');
const { createDocumentProcessor } = require('../src/services/document-processing/process-document');
const { retryAfterSeconds, retryDelayMs } = require('../src/services/ai/retry-policy');

const sample = require('../openapi.json').paths['/api/v1/ocr/process'].post.requestBody.content['application/json'].examples.transportExample.value;
function configuration(env = {}) {
  return loadConfig({ SERVICE_TOKEN: 'reliability-service-token', OPENAI_API_KEY: 'reliability-dummy-key', OPENAI_MODEL: 'test-model', OPENAI_BASE_URL: 'https://provider.example.invalid/v1', PROCESSING_TIMEOUT_MS: '5000', AI_REQUEST_TIMEOUT_MS: '1000', ...env });
}
function prepared() { return { status: 'prepared', pageCount: 1, pages: [{ pageNumber: 1, mimeType: 'image/png', contentBase64: sample.file.contentBase64 }] }; }
function extraction(overrides = {}) {
  return { readable: true, detectedDocumentType: 'student_certificate', fields: { fullName: 'Иван Петров Иванов', facultyNumber: '001234567', specialty: 'Информатика', yearOfStudy: 2 }, uncertainFields: [], ...overrides };
}
function envelope(value = extraction()) { return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] }; }
function response(value, status = 200, headers = {}) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } }); }
function context(config, signal) { return { deadlineAt: performance.now() + config.limits.processingTimeoutMs, signal }; }
async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('Retry-After accepts integer seconds and HTTP dates but never reflects arbitrary provider text', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(retryAfterSeconds('2', now), 2);
  assert.equal(retryAfterSeconds('0', now), 0);
  assert.equal(retryAfterSeconds(new Date(now + 4000).toUTCString(), now), 4);
  assert.equal(retryAfterSeconds(new Date(now - 1000).toUTCString(), now), 0);
  for (const value of [null, '', '-1', '1.5', 'private-provider-content', 'x'.repeat(129), '9'.repeat(100)]) {
    assert.equal(retryAfterSeconds(value, now), undefined);
  }
  assert.equal(retryDelayMs({ details: { retryAfterSeconds: 1 } }), 1000);
  assert.equal(retryDelayMs({ details: {} }), 250);
});

test('a fitting Retry-After is honored and still permits at most one internal retry', async () => {
  const config = configuration();
  const starts = [];
  const client = createGptVisionClient(config, { fetchImpl: async () => {
    starts.push(performance.now());
    return starts.length === 1 ? response({ private: 'private-provider-content' }, 429, { 'Retry-After': '1' }) : response(envelope());
  } });
  const value = await client.extract(prepared(), 'student_certificate', context(config));
  assert.equal(value.fields.facultyNumber, '001234567');
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 950);
});

test('a long Retry-After skips internal retry and is returned as safe JSON and HTTP metadata', async (t) => {
  let calls = 0;
  const upstream = await listen(t, http.createServer((req, res) => {
    req.resume(); calls += 1;
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '120' });
    res.end(JSON.stringify({ private: 'private-provider-content' }));
  }));
  const config = configuration({ OPENAI_BASE_URL: `${upstream}/v1`, PROCESSING_TIMEOUT_MS: '1000' });
  const processor = createDocumentProcessor(config, { prepare: async () => prepared() });
  const api = await listen(t, http.createServer(createApp({ config, processDocument: processor })));
  const result = await fetch(`${api}/api/v1/ocr/process`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Token': 'reliability-service-token' }, body: JSON.stringify(sample) });
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('retry-after'), '120');
  const body = await result.json();
  assert.equal(body.error.code, 'provider_unavailable');
  assert.equal(body.error.retryable, true);
  assert.deepEqual(body.error.details, { retryAfterSeconds: 120 });
  assert.ok(!JSON.stringify(body).includes('private-provider-content'));
  assert.equal(calls, 1);
});

test('cancellation during retry backoff never starts a second provider request', async () => {
  const config = configuration();
  const controller = new AbortController();
  let calls = 0;
  const client = createGptVisionClient(config, { fetchImpl: async () => {
    calls += 1;
    setImmediate(() => controller.abort());
    return response({}, 503, { 'Retry-After': '1' });
  } });
  await assert.rejects(client.extract(prepared(), 'student_certificate', context(config, controller.signal)), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('the shared deadline bounds a transport that ignores its AbortSignal', { timeout: 2000 }, async () => {
  const config = configuration({ PROCESSING_TIMEOUT_MS: '50' });
  let attemptSignal;
  const client = createGptVisionClient(config, { fetchImpl: (url, options) => { attemptSignal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(client.extract(prepared(), 'student_certificate', context(config)), (error) => error.status === 504 && error.code === 'processing_timeout');
  assert.equal(attemptSignal.aborted, true);
});

test('late responses after timeout are discarded and can never become a successful extraction', { timeout: 2000 }, async () => {
  const config = configuration({ PROCESSING_TIMEOUT_MS: '200', AI_REQUEST_TIMEOUT_MS: '25' });
  let complete;
  let cancelled = 0;
  let calls = 0;
  const client = createGptVisionClient(config, { fetchImpl: () => { calls += 1; return new Promise((resolve) => { complete = resolve; }); } });
  await assert.rejects(client.extract(prepared(), 'student_certificate', context(config)), (error) => error.status === 504);
  complete(new Response(new ReadableStream({ cancel() { cancelled += 1; } }), { headers: { 'Content-Type': 'application/json' } }));
  await nextTurn();
  assert.equal(cancelled, 1);
  assert.equal(calls, 1);
});

test('a body stream disconnected from fetch cancellation is explicitly cancelled at timeout', { timeout: 2000 }, async () => {
  const config = configuration({ PROCESSING_TIMEOUT_MS: '200', AI_REQUEST_TIMEOUT_MS: '25' });
  let cancelled = 0;
  const client = createGptVisionClient(config, { fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('{"choices":')); },
    cancel() { cancelled += 1; },
  }), { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(client.extract(prepared(), 'student_certificate', context(config)), (error) => error.status === 504);
  assert.equal(cancelled, 1);
});

test('orchestration checks the deadline/cancellation before entering the next stage', async () => {
  let calls = 0;
  const client = { mode: 'openai', assertConfigured() {}, extract: async () => { calls += 1; return extraction(); } };
  const slowPreparation = createDocumentProcessor(configuration({ PROCESSING_TIMEOUT_MS: '1' }), { client, prepare: async () => {
    await new Promise((resolve) => setTimeout(resolve, 10)); return prepared();
  } });
  await assert.rejects(slowPreparation({ documentType: 'student_certificate' }), (error) => error.code === 'processing_timeout');
  const controller = new AbortController();
  const cancelledPreparation = createDocumentProcessor(configuration(), { client, prepare: async () => { controller.abort(); return prepared(); } });
  await assert.rejects(cancelledPreparation({ documentType: 'student_certificate', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('HTTP disconnect during AI transport aborts that attempt and prevents retries', async (t) => {
  const config = configuration();
  let started;
  let stopped;
  const ready = new Promise((resolve) => { started = resolve; });
  const aborted = new Promise((resolve) => { stopped = resolve; });
  let calls = 0;
  const client = createGptVisionClient(config, { fetchImpl: (url, options) => new Promise((resolve, reject) => {
    calls += 1;
    options.signal.addEventListener('abort', () => { stopped(); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    started();
  }) });
  const processor = createDocumentProcessor(config, { client, prepare: async () => prepared() });
  const api = await listen(t, http.createServer(createApp({ config, processDocument: processor })));
  const controller = new AbortController();
  const pending = fetch(`${api}/api/v1/ocr/process`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Service-Token': 'reliability-service-token' }, body: JSON.stringify(sample) });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await ready;
  controller.abort();
  await rejected;
  await aborted;
  assert.equal(calls, 1);
});

test('the same original document and ID can recover after failures; semantic issues are not retried', async (t) => {
  let mode = 'unavailable';
  let calls = 0;
  const upstream = await listen(t, http.createServer((req, res) => {
    req.resume(); calls += 1;
    res.writeHead(mode === 'unavailable' ? 503 : 200, { 'Content-Type': 'application/json' });
    if (mode === 'unavailable') res.end(JSON.stringify({ private: 'private-provider-content' }));
    else if (mode === 'malformed') res.end('private-provider-content');
    else res.end(JSON.stringify(envelope(mode === 'unreadable' ? extraction({ readable: false }) : mode === 'invalid_year' ? extraction({ fields: { ...extraction().fields, yearOfStudy: 9 } }) : extraction())));
  }));
  const config = configuration({ OPENAI_BASE_URL: `${upstream}/v1` });
  const processor = createDocumentProcessor(config, { prepare: async () => prepared() });
  const api = await listen(t, http.createServer(createApp({ config, processDocument: processor })));
  const original = Buffer.from(sample.file.contentBase64, 'base64');
  const hash = () => createHash('sha256').update(original).digest('hex');
  const before = hash();
  const payload = JSON.stringify(sample);
  for (const [scenario, status, attempts] of [['unavailable', 503, 2], ['malformed', 502, 2], ['unreadable', 422, 1], ['invalid_year', 200, 1], ['valid', 200, 1]]) {
    mode = scenario;
    const count = calls;
    const reply = await fetch(`${api}/api/v1/ocr/process`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Token': 'reliability-service-token' }, body: payload });
    assert.equal(reply.status, status);
    const body = await reply.json();
    assert.ok(!JSON.stringify(body).includes('private-provider-content'));
    assert.ok(!JSON.stringify(body).includes('reliability-dummy-key'));
    if (scenario === 'invalid_year') {
      assert.equal(body.status, 'partial');
      assert.equal(body.fields.yearOfStudy, 9);
      assert.ok(body.fieldIssues.some((issue) => issue.code === 'invalid_format'));
    }
    if (scenario === 'valid') assert.equal(body.status, 'completed');
    assert.equal(calls - count, attempts);
    assert.equal(hash(), before);
    assert.equal((await fetch(`${api}/health`)).status, 200);
  }
});
