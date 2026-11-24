const { isUtf8 } = require('node:buffer');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { ApiError } = require('../../errors/api-error');
const { badAiResponse, validateAiExtraction } = require('../../validators/ai-extraction');
const { buildVisionRequest } = require('./vision-request');
const { getDocumentProfile } = require('./document-profiles');
const { retryAfterSeconds, retryDelayMs } = require('./retry-policy');

function processingTimeout() {
  return new ApiError(504, 'processing_timeout', 'The processing deadline was exceeded.', { retryable: true });
}

function checkActive(signal, deadlineAt) {
  if (signal?.aborted) throw new DOMException('Extraction was cancelled.', 'AbortError');
  if (performance.now() >= deadlineAt) throw processingTimeout();
}

function discardBody(response) {
  try { if (response.body) void response.body.cancel().catch(() => {}); }
  catch { /* Cleanup must not replace a timeout or safe provider error. */ }
}

async function readJson(response, maximum, signal) {
  if (signal.aborted) {
    discardBody(response);
    throw new DOMException('AI attempt was aborted.', 'AbortError');
  }
  const declared = Number(response.headers.get('content-length'));
  if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
    || (Number.isFinite(declared) && declared > maximum) || !response.body) {
    discardBody(response);
    throw badAiResponse();
  }
  const reader = response.body.getReader();
  const cancelReader = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelReader, { once: true });
  if (signal.aborted) cancelReader();
  const chunks = [];
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) { complete = true; break; }
      bytes += chunk.value.length;
      if (bytes > maximum) {
        cancelReader();
        throw badAiResponse();
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    if (!complete) cancelReader();
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, bytes);
  if (!isUtf8(body)) throw badAiResponse();
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw badAiResponse();
  }
}

function providerStatusError(status, headers) {
  if (status === 401 || status === 403) {
    return new ApiError(503, 'provider_configuration_error', 'AI provider authentication failed. Check its credentials.');
  }
  if (status === 408 || status === 504) {
    const seconds = retryAfterSeconds(headers.get('retry-after'));
    return new ApiError(504, 'provider_timeout', 'The AI provider timed out.', { retryable: true, details: seconds === undefined ? {} : { retryAfterSeconds: seconds } });
  }
  if (status === 429 || status >= 500) {
    const seconds = retryAfterSeconds(headers.get('retry-after'));
    return new ApiError(503, 'provider_unavailable', 'The AI provider is temporarily unavailable.', { retryable: true, details: seconds === undefined ? {} : { retryAfterSeconds: seconds } });
  }
  return new ApiError(502, 'provider_request_rejected', 'AI rejected the extraction request. Check model/API compatibility.');
}

async function requestExtraction(body, config, fetchImpl, attemptSignal, signal, deadlineAt, documentType) {
  if (attemptSignal.aborted) throw new DOMException('AI attempt was aborted.', 'AbortError');
  checkActive(signal, deadlineAt);
  const response = await fetchImpl(`${config.ai.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', redirect: 'manual', signal: attemptSignal,
    headers: { Authorization: `Bearer ${config.ai.apiKey}`, 'Content-Type': 'application/json' },
    body,
  });
  if (attemptSignal.aborted) {
    discardBody(response);
    throw new DOMException('AI attempt was aborted.', 'AbortError');
  }
  if (!response.ok) {
    discardBody(response);
    throw providerStatusError(response.status, response.headers);
  }
  const envelope = await readJson(response, config.limits.maxAiResponseBytes, attemptSignal);
  if (attemptSignal.aborted) throw new DOMException('AI attempt was aborted.', 'AbortError');
  const choice = Array.isArray(envelope?.choices) && envelope.choices.length === 1 ? envelope.choices[0] : null;
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
    throw new ApiError(502, 'provider_request_rejected', 'AI declined extraction. Use manual review for this document.');
  }
  if (choice?.finish_reason !== 'stop' || choice?.message?.role !== 'assistant' || typeof choice.message.content !== 'string') {
    throw badAiResponse();
  }
  let extraction;
  try {
    extraction = JSON.parse(choice.message.content);
  } catch {
    throw badAiResponse();
  }
  const result = validateAiExtraction(extraction, documentType);
  checkActive(signal, deadlineAt);
  return result;
}

async function performAttempt(payload, config, fetchImpl, signal, deadlineAt, documentType) {
  checkActive(signal, deadlineAt);
  const body = JSON.stringify(payload);
  checkActive(signal, deadlineAt);
  const controller = new AbortController();
  let interrupt;
  const interrupted = new Promise((resolve, reject) => { interrupt = reject; });
  const onAbort = () => {
    interrupt(new DOMException('Extraction was cancelled.', 'AbortError'));
    controller.abort();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let expired = false;
  const remaining = deadlineAt - performance.now();
  const timeoutFailure = remaining <= config.ai.requestTimeoutMs
    ? processingTimeout() : new ApiError(504, 'provider_timeout', 'The AI request timed out.', { retryable: true });
  const timer = setTimeout(() => {
    expired = true;
    interrupt(timeoutFailure);
    controller.abort();
  }, Math.max(1, Math.ceil(Math.min(config.ai.requestTimeoutMs, remaining))));
  try {
    if (signal?.aborted) onAbort();
    return await Promise.race([requestExtraction(body, config, fetchImpl, controller.signal, signal, deadlineAt, documentType), interrupted]);
  } catch (error) {
    checkActive(signal, deadlineAt);
    if (expired) throw timeoutFailure;
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'provider_unavailable', 'Could not communicate with the AI provider.', { retryable: true });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function createGptVisionClient(config, { fetchImpl = globalThis.fetch } = {}) {
  function assertConfigured() {
    if (!config.ai.apiKey || !config.ai.model) {
      throw new ApiError(503, 'provider_configuration_error', 'Configure OPENAI_API_KEY and OPENAI_MODEL before using the OpenAI provider.', { details: { stage: 'extraction' } });
    }
  }
  return {
    mode: 'openai',
    assertConfigured,
    async extract(prepared, documentType, { signal, deadlineAt }) {
      getDocumentProfile(documentType);
      checkActive(signal, deadlineAt);
      assertConfigured();
      const payload = buildVisionRequest(prepared, documentType, config);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await performAttempt(payload, config, fetchImpl, signal, deadlineAt, documentType);
        } catch (error) {
          if (!(error instanceof ApiError) || !error.retryable || error.code === 'processing_timeout' || attempt === 1) throw error;
          const wait = retryDelayMs(error);
          if (deadlineAt - performance.now() <= wait) throw error;
          await delay(wait, undefined, { signal });
          checkActive(signal, deadlineAt);
        }
      }
      throw badAiResponse();
    },
  };
}

module.exports = { createGptVisionClient };
