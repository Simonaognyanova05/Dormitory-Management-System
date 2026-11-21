const { performance } = require('node:perf_hooks');
const os = require('node:os');
const { ApiError } = require('../errors/api-error');
const { validateProcessRequest } = require('../validators/process-request');
const { inspectDocumentFile } = require('../validators/document-file');
const { createDocumentProcessor } = require('../services/document-processing/process-document');
const { EvaluationError, readBoundedFile, sha256 } = require('./dataset');
const { validateResult, scoreFields, summarize } = require('./scoring');

function assertEvaluationConfig(config) {
  if (config.ai.provider !== 'openai') throw new EvaluationError('Use AI_PROVIDER=openai for measurements. Mock mode is not OCR; use --validate-only without provider calls.', 'evaluation_config');
  if (!config.ai.apiKey || !config.ai.model) throw new EvaluationError('Set OPENAI_API_KEY and OPENAI_MODEL locally before measuring recognition.', 'evaluation_config');
}

async function runEvaluation(dataset, config, { processDocument = createDocumentProcessor(config), signal, includeValues = false, onProgress } = {}) {
  assertEvaluationConfig(config);
  const startedAt = new Date().toISOString();
  const rows = [];
  let aborted = false;
  let abortCode = null;
  for (const document of dataset.documents) {
    const row = {
      id: document.id, quality: document.quality, fileSha256: document.sha256, pageCount: document.pageCount,
      state: 'not_attempted', resultStatus: null, requiresManualReview: null, errorCode: null,
      retryAfterSeconds: null,
      detectedDocumentType: null, warnings: [],
      timings: { admissionMs: null, preprocessingMs: null, aiMs: null, validationMs: null, totalMs: null },
      fields: scoreFields(document.expectedFields, null, { includeValues }),
    };
    rows.push(row);
    if (aborted || signal?.aborted) { aborted = true; abortCode ||= 'cancelled'; continue; }
    let start;
    let finished;
    let stageTimings;
    try {
      // Reads/encoding are outside processing time; hashes prevent scoring changed inputs.
      const buffer = await readBoundedFile(document.filePath, config.limits.maxFileBytes);
      if (sha256(buffer) !== document.sha256) throw new EvaluationError('Dataset file changed after validation.', 'dataset_changed');
      const body = { documentId: document.id, documentType: document.documentType, file: { mimeType: document.mimeType, contentBase64: buffer.toString('base64') } };
      start = performance.now();
      const input = validateProcessRequest(body, config.limits);
      const metadata = await inspectDocumentFile(input, config.limits);
      row.timings.admissionMs = performance.now() - start;
      const result = await processDocument({ ...input, metadata, signal }, { onTiming: (timings) => { stageTimings = timings; } });
      finished = performance.now();
      validateResult(result, document);
      row.fields = scoreFields(document.expectedFields, result, { includeValues });
      row.state = 'success';
      row.resultStatus = result.status;
      row.requiresManualReview = result.requiresManualReview;
      row.detectedDocumentType = result.detectedDocumentType;
      row.warnings = [...result.warnings];
    } catch (error) {
      finished ??= performance.now();
      if (error instanceof EvaluationError && error.code === 'mock_result') throw error;
      row.state = signal?.aborted || error.name === 'AbortError' ? 'cancelled' : 'error';
      row.errorCode = row.state === 'cancelled' ? 'cancelled' : error instanceof ApiError || error instanceof EvaluationError ? error.code : 'internal_error';
      const retryAfter = error instanceof ApiError && error.retryable ? error.details?.retryAfterSeconds : undefined;
      if (Number.isSafeInteger(retryAfter) && retryAfter >= 0) row.retryAfterSeconds = retryAfter;
      if (row.state === 'cancelled' || ['provider_configuration_error', 'processing_not_configured', 'dataset_changed', 'invalid_dataset'].includes(row.errorCode)) {
        aborted = true;
        abortCode = row.errorCode;
      } else if (row.retryAfterSeconds > 0) {
        // Do not start a different document while the provider explicitly requests a pause.
        aborted = true;
        abortCode = 'provider_retry_after';
      }
    } finally {
      if (stageTimings) Object.assign(row.timings, { preprocessingMs: stageTimings.preprocessingMs, aiMs: stageTimings.aiMs, validationMs: stageTimings.validationMs });
      row.timings.totalMs = start === undefined ? null : (finished ?? performance.now()) - start;
    }
    if (typeof onProgress === 'function') onProgress({ id: row.id, state: row.state, errorCode: row.errorCode });
  }
  return {
    schemaVersion: 1, scope: 'early-student-certificate-check', comparisonVersion: 'certificate-v1',
    startedAt, finishedAt: new Date().toISOString(), aborted, abortCode,
    dataset: { datasetId: dataset.datasetId, synthetic: dataset.synthetic, language: dataset.language, documents: dataset.documents.length, manifestSha256: dataset.manifestSha256 },
    provider: { name: config.ai.provider, model: config.ai.model, baseUrl: config.ai.baseUrl, imageDetail: config.ai.imageDetail, temperature: config.ai.temperature ?? null, maxOutputTokens: config.ai.maxOutputTokens, requestTimeoutMs: config.ai.requestTimeoutMs },
    environment: { node: process.version, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model || 'unknown' },
    limits: { ...config.limits }, includeValues,
    summary: summarize(rows, { aborted }), documents: rows,
  };
}

module.exports = { assertEvaluationConfig, runEvaluation };
