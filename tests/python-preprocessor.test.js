const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { test } = require('node:test');
const { loadConfig } = require('../src/config/env');
const { createPythonPreprocessor } = require('../src/services/document-processing/python-preprocessor');
const { createApp } = require('../src/app');

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(__dirname, 'fixtures', 'preprocessor-child.cjs');
const example = require('../openapi.json').paths['/api/v1/ocr/process'].post.requestBody.content['application/json'].examples.transportExample.value;
const input = { buffer: Buffer.from(example.file.contentBase64, 'base64'), mimeType: 'image/png', metadata: { pageCount: 1 } };

function fixture(t, mode, env = {}) {
  const config = loadConfig({ SERVICE_TOKEN: 'integration-test-token', PROCESSING_TIMEOUT_MS: '3000', ...env });
  const states = [];
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const prepare = createPythonPreprocessor(config, {
    spawnProcess: (command, args, options) => {
      assert.equal(options.shell, false);
      assert.equal(options.cwd, ROOT);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      assert.equal(args[0], path.join(ROOT, 'python', 'preprocess.py'));
      assert.ok(args.includes('--stdin'));
      assert.ok(!args.includes('--output-dir'));
      assert.equal(args[args.indexOf('--max-pages') + 1], String(config.limits.maxPdfPages));
      if (env.PYTHON_COMMAND) assert.equal(command, path.resolve(ROOT, env.PYTHON_COMMAND));
      const child = spawn(process.execPath, [WORKER, mode], options);
      const state = { child, closed: false, close: null };
      state.close = new Promise((resolve) => child.once('close', () => { state.closed = true; resolve(); }));
      states.push(state);
      ready(state);
      return child;
    },
  });
  t.after(async () => {
    for (const state of states) {
      if (!state.closed) state.child.kill('SIGKILL');
      await state.close;
    }
  });
  return { prepare, states, started, config };
}

function safeError(status, code) {
  return (error) => {
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.ok(!JSON.stringify({ message: error.message, details: error.details }).includes('private-worker-content'));
    return true;
  };
}

test('streams raw input and parses complete/chunked JSON without a shell or temp files', async (t) => {
  for (const mode of ['valid', 'chunked', 'with-diagnostics']) {
    const worker = fixture(t, mode, { PYTHON_COMMAND: 'path with spaces/python.exe' });
    const result = await worker.prepare(input);
    assert.equal(result.status, 'prepared');
    assert.equal(result.pages[0].width, 1);
    assert.ok(worker.states[0].closed);
  }
});

test('rejects malformed JSON, multiple objects and invalid page/image metadata', async (t) => {
  for (const mode of ['bad-json', 'two-json', 'bad-dimensions', 'bad-order', 'bad-count', 'bad-base64', 'bad-pixels', 'bad-transforms', 'extra-root', 'success-with-error-exit', 'unknown-error', 'invalid-error-code']) {
    const worker = fixture(t, mode);
    await assert.rejects(worker.prepare(input), safeError(500, 'internal_error'));
    assert.ok(worker.states[0].closed);
  }
});

test('rejects missing pages compared with the inspected source PDF', async (t) => {
  const worker = fixture(t, 'valid');
  await assert.rejects(worker.prepare({ ...input, mimeType: 'application/pdf', metadata: { pageCount: 3 } }), safeError(500, 'internal_error'));
});

test('maps known Python errors without forwarding arbitrary messages or details', async (t) => {
  const worker = fixture(t, 'known-error');
  await assert.rejects(worker.prepare(input), safeError(415, 'unsupported_file'));
});

test('reports missing executables, synchronous spawn failures and missing Python imports safely', async (t) => {
  const config = loadConfig({ PYTHON_COMMAND: 'missing-python-executable-for-ocr-test' });
  await assert.rejects(createPythonPreprocessor(config)(input), safeError(503, 'processing_not_configured'));
  const throwing = createPythonPreprocessor(config, { spawnProcess: () => { throw new Error('private-worker-content'); } });
  await assert.rejects(throwing(input), safeError(503, 'processing_not_configured'));
  const worker = fixture(t, 'import-failure');
  await assert.rejects(worker.prepare(input), safeError(503, 'processing_not_configured'));
});

test('kills the worker when stdout or stderr exceeds its configured cap', async (t) => {
  for (const [mode, env] of [['flood-stdout', { MAX_PREPROCESS_STDOUT_BYTES: '128' }], ['flood-stderr', { MAX_PREPROCESS_STDERR_BYTES: '32' }]]) {
    const worker = fixture(t, mode, env);
    await assert.rejects(worker.prepare(input), safeError(500, 'internal_error'));
    assert.ok(worker.states[0].closed);
    assert.ok(worker.states[0].child.killed);
  }
});

test('stream read failures terminate the process without leaking OS error details', async (t) => {
  for (const stream of ['stdout', 'stderr']) {
    const worker = fixture(t, 'hang');
    const rejected = assert.rejects(worker.prepare(input), safeError(500, 'internal_error'));
    const state = await worker.started;
    state.child[stream].emit('error', new Error('private-worker-content'));
    await rejected;
    assert.ok(state.closed);
  }
});

test('timeout terminates a stalled process before rejecting and is retryable', async (t) => {
  const worker = fixture(t, 'hang', { PROCESSING_TIMEOUT_MS: '500' });
  await assert.rejects(worker.prepare(input), (error) => {
    safeError(504, 'processing_timeout')(error);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.ok(worker.states[0].closed);
  assert.ok(worker.states[0].child.killed);
});

test('an expired deadline or pre-aborted request never starts a process', async (t) => {
  const worker = fixture(t, 'valid');
  await assert.rejects(worker.prepare(input, { deadlineAt: performance.now() - 1 }), safeError(504, 'processing_timeout'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(worker.prepare(input, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(worker.states.length, 0);
});

test('cancellation kills and closes an already started worker', async (t) => {
  const worker = fixture(t, 'hang');
  const controller = new AbortController();
  const result = worker.prepare(input, { signal: controller.signal });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await worker.started;
  controller.abort();
  await rejected;
  assert.ok(worker.states[0].closed);
});

test('an HTTP client disconnect cancels its worker without sending an error response', async (t) => {
  const worker = fixture(t, 'hang');
  let processingFailed;
  const processingError = new Promise((resolve) => { processingFailed = resolve; });
  const server = createApp({ config: worker.config, processDocument: async (value) => {
    try {
      return await worker.prepare(value);
    } catch (error) {
      processingFailed(error);
      throw error;
    }
  } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${server.address().port}/api/v1/ocr/process`, {
    method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': 'integration-test-token' },
    body: JSON.stringify(example),
  });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  const state = await worker.started;
  controller.abort();
  await rejected;
  await state.close;
  assert.equal((await processingError).name, 'AbortError');
  assert.ok(state.child.killed);
});

test('does not accept success if stdin failed before the file was delivered', async (t) => {
  const worker = fixture(t, 'early-success');
  await assert.rejects(worker.prepare({ ...input, buffer: Buffer.alloc(10 * 1024 * 1024) }), safeError(500, 'internal_error'));
});
