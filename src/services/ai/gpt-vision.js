const { isUtf8 } = require('node:buffer');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { ApiError } = require('../../errors/api-error');
const { badAiResponse, validateAiExtraction } = require('../../validators/ai-extraction');
const { buildVisionRequest, requireCertificate } = require('./certificate-profile');

function processingTimeout() {
  return new ApiError(504, 'processing_timeout', 'The processing deadline was exceeded.', { retryable: true });
}

function checkActive(signal, deadlineAt) {
  if (signal?.aborted) throw new DOMException('Extraction was cancelled.', 'AbortError');
  if (performance.now() >= deadlineAt) throw processingTimeout();
}

function discardBody(response) {
  if (response.body) void response.body.cancel().catch(() => {});
}

async function readJson(response, maximum) {
  const declared = Number(response.headers.get('content-length'));
  if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
    || (Number.isFinite(declared) && declared > maximum) || !response.body) {
    discardBody(response);
    throw badAiResponse();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > maximum) {
        void reader.cancel().catch(() => {});
        throw badAiResponse();
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
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

function providerStatusError(status) {
  if (status === 401 || status === 403) {
    return new ApiError(503, 'provider_configuration_error', 'AI provider authentication failed. Check its credentials.');
  }
  if (status === 408 || status === 504) {
    return new ApiError(504, 'provider_timeout', 'The AI provider timed out.', { retryable: true });
  }
  if (status === 429 || status >= 500) {
    return new ApiError(503, 'provider_unavailable', 'The AI provider is temporarily unavailable.', { retryable: true });
  }
  return new ApiError(502, 'provider_request_rejected', 'AI rejected the extraction request. Check model/API compatibility.');
}

async function performAttempt(payload, config, fetchImpl, signal, deadlineAt) {
  checkActive(signal, deadlineAt);
  const body = JSON.stringify(payload);
  checkActive(signal, deadlineAt);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, Math.min(config.ai.requestTimeoutMs, deadlineAt - performance.now()));
  try {
    const response = await fetchImpl(`${config.ai.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${config.ai.apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) {
      discardBody(response);
      throw providerStatusError(response.status);
    }
    const envelope = await readJson(response, config.limits.maxAiResponseBytes);
    if (expired) throw new ApiError(504, 'provider_timeout', 'The AI request timed out.', { retryable: true });
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
    const result = validateAiExtraction(extraction);
    checkActive(signal, deadlineAt);
    return result;
  } catch (error) {
    checkActive(signal, deadlineAt);
    if (expired) throw new ApiError(504, 'provider_timeout', 'The AI request timed out.', { retryable: true });
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
      requireCertificate(documentType);
      checkActive(signal, deadlineAt);
      assertConfigured();
      const payload = buildVisionRequest(prepared, documentType, config);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await performAttempt(payload, config, fetchImpl, signal, deadlineAt);
        } catch (error) {
          if (!(error instanceof ApiError) || !error.retryable || error.code === 'processing_timeout'
            || attempt === 1 || deadlineAt - performance.now() <= 250) throw error;
          await delay(250, undefined, { signal });
          checkActive(signal, deadlineAt);
        }
      }
      throw badAiResponse();
    },
  };
}

module.exports = { createGptVisionClient };
