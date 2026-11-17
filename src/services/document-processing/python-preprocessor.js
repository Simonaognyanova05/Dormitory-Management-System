const { spawn } = require('node:child_process');
const { isUtf8 } = require('node:buffer');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ApiError } = require('../../errors/api-error');
const { MAX_PREPARED_SIDE, invalidPreparedOutput, validatePreparedDocument } = require('../../validators/prepared-document');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(PROJECT_ROOT, 'python', 'preprocess.py');
const MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function timeoutError() {
  return new ApiError(504, 'processing_timeout', 'The processing deadline was exceeded.', { retryable: true });
}

function abortError() {
  return new DOMException('Preprocessing was cancelled.', 'AbortError');
}

function unavailableError() {
  return new ApiError(503, 'processing_not_configured', 'Could not start Python preprocessing. Check PYTHON_COMMAND, the script and installed dependencies.', {
    details: { stage: 'preprocessing' },
  });
}

function parseOutput(bytes) {
  if (!bytes.length || !isUtf8(bytes)) throw invalidPreparedOutput();
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalidPreparedOutput();
  }
}

function pythonReportedError(payload, code, config) {
  const error = payload?.error;
  if (!payload || Object.keys(payload).length !== 1 || !error || typeof error !== 'object'
    || Array.isArray(error) || Object.keys(error).length !== 4
    || typeof error.code !== 'string' || typeof error.message !== 'string' || error.retryable !== false
    || !error.details || typeof error.details !== 'object' || Array.isArray(error.details)) {
    return invalidPreparedOutput();
  }
  // Map only known codes; never forward Python's arbitrary message/details or stderr.
  const errors = {
    invalid_request: [400, 'Invalid preprocessing arguments.', {}],
    file_too_large: [413, 'File exceeds a preprocessing limit.', { maxBytes: config.limits.maxFileBytes, maxPixels: config.limits.maxImagePixels }],
    page_limit_exceeded: [413, 'PDF exceeds the configured page limit.', { maxPages: config.limits.maxPdfPages }],
    unsupported_file: [415, 'Invalid file or MIME type mismatch.', {}],
    unreadable_document: [422, 'Document cannot be prepared for extraction.', {}],
    internal_error: [500, 'Document preprocessing failed.', {}],
  };
  const mapped = Object.hasOwn(errors, error.code) ? errors[error.code] : null;
  if (!mapped || (error.code === 'internal_error' ? code !== 1 : code !== 2)) return invalidPreparedOutput();
  return new ApiError(mapped[0], error.code, mapped[1], { details: mapped[2] });
}

function collectOutput(input, config, { signal, deadlineAt, spawnProcess }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const remaining = deadlineAt - performance.now();
    if (remaining <= 0) return reject(timeoutError());

    const command = /[\\/]/.test(config.pythonCommand)
      ? path.resolve(PROJECT_ROOT, config.pythonCommand) : config.pythonCommand;
    const args = [
      SCRIPT, '--stdin', '--mime-type', input.mimeType,
      '--max-file-bytes', String(config.limits.maxFileBytes),
      '--max-pages', String(config.limits.maxPdfPages),
      '--max-pixels', String(config.limits.maxImagePixels),
      '--max-side', String(MAX_PREPARED_SIDE),
    ];
    let child;
    try {
      child = spawnProcess(command, args, {
        cwd: PROJECT_ROOT,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      });
    } catch {
      return reject(unavailableError());
    }

    let chunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure;
    let stdinFailed = false;
    let forceKill;
    let closed = false;

    function stop(error) {
      if (failure || closed) return;
      failure = error;
      chunks = [];
      child.stdin.destroy();
      if (child.pid) {
        child.kill('SIGTERM');
        forceKill = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 250);
        forceKill.unref();
      }
    }

    const timer = setTimeout(() => stop(timeoutError()), remaining);
    timer.unref();
    const onAbort = () => stop(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', () => stop(unavailableError()));
    child.stdin.on('error', () => { stdinFailed = true; });
    child.stdout.on('error', () => stop(new ApiError(500, 'internal_error', 'Could not read preprocessing output.')));
    child.stderr.on('error', () => stop(new ApiError(500, 'internal_error', 'Could not read preprocessing diagnostics.')));
    child.stdout.on('data', (chunk) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > config.limits.maxPreprocessStdoutBytes) {
        stop(new ApiError(500, 'internal_error', 'Preprocessing output exceeded its byte limit.'));
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.on('data', (chunk) => {
      // Diagnostics are counted and discarded, never included in a response or log.
      stderrBytes += chunk.length;
      if (stderrBytes > config.limits.maxPreprocessStderrBytes) {
        stop(new ApiError(500, 'internal_error', 'Preprocessing diagnostics exceeded their byte limit.'));
      }
    });
    child.once('close', (code) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(forceKill);
      signal?.removeEventListener('abort', onAbort);
      if (failure) return reject(failure);
      if (performance.now() >= deadlineAt) return reject(timeoutError());

      const bytes = Buffer.concat(chunks, stdoutBytes);
      chunks = [];
      let payload;
      try {
        payload = parseOutput(bytes);
      } catch (error) {
        return reject(code === 1 || code === 2 ? unavailableError() : error);
      }
      if (code !== 0) return reject(pythonReportedError(payload, code, config));
      if (stdinFailed) return reject(new ApiError(500, 'internal_error', 'Could not deliver the document to Python.'));
      return resolve(payload);
    });

    if (signal?.aborted) stop(abortError());
    if (!failure) child.stdin.end(input.buffer);
  });
}

async function validateWithinDeadline(payload, input, config, deadlineAt, signal) {
  if (signal?.aborted) throw abortError();
  const remaining = deadlineAt - performance.now();
  if (remaining <= 0) throw timeoutError();
  let timer;
  let onAbort;
  try {
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(timeoutError()), remaining);
      timer.unref();
      onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const result = await Promise.race([validatePreparedDocument(payload, input, config), deadline]);
    if (performance.now() >= deadlineAt) throw timeoutError();
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function createPythonPreprocessor(config, { spawnProcess = spawn } = {}) {
  return async (input, { signal = input.signal, deadlineAt = performance.now() + config.limits.processingTimeoutMs } = {}) => {
    if (!Buffer.isBuffer(input.buffer) || !input.buffer.length || !MIME_TYPES.has(input.mimeType)) {
      throw new ApiError(415, 'unsupported_file', 'A supported nonempty document is required.');
    }
    if (input.buffer.length > config.limits.maxFileBytes) {
      throw new ApiError(413, 'file_too_large', 'File exceeds the configured byte limit.');
    }
    const payload = await collectOutput(input, config, { signal, deadlineAt, spawnProcess });
    return validateWithinDeadline(payload, input, config, deadlineAt, signal);
  };
}

module.exports = { createPythonPreprocessor };
