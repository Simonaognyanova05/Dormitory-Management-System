const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { test } = require('node:test');
const sharp = require('sharp');
const { loadConfig } = require('../src/config/env');
const { ApiError } = require('../src/errors/api-error');
const { createDocumentProcessor } = require('../src/services/document-processing/process-document');
const { loadDataset, validateManifest, EvaluationError } = require('../src/evaluation/dataset');
const { scoreFields, distribution, summarize, validateResult, markdownReport } = require('../src/evaluation/scoring');
const { runEvaluation } = require('../src/evaluation/run-evaluation');

const execute = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
function expected(index = 1) { return { fullName: `Тестов Студент ${index}`, facultyNumber: `00012${String(index).padStart(4, '0')}`, specialty: 'Информатика', yearOfStudy: 2 }; }
function result(document, overrides = {}) {
  return { documentId: document.id, documentType: 'student_certificate', detectedDocumentType: 'student_certificate', status: 'completed', fields: { ...document.expectedFields }, fieldIssues: [], warnings: [], requiresManualReview: false, ...overrides };
}
function manifest() {
  return { schemaVersion: 1, datasetId: 'test-only-fixture', synthetic: true, language: 'bg', documents: Array.from({ length: 10 }, (_, index) => ({ id: `cert-${index}`, file: `cert-${index}.png`, mimeType: 'image/png', documentType: 'student_certificate', quality: index % 2 ? 'clean' : 'skewed', expectedFields: expected(index) })) };
}
function config(env = {}) { return loadConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-not-a-real-key', OPENAI_MODEL: 'test-fixture-model', ...env }); }
async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-evaluation-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const data = manifest();
  // These small colored inputs test the evaluator, not actual recognition quality.
  for (const [index, document] of data.documents.entries()) {
    await fs.writeFile(path.join(folder, document.file), await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: index * 17, g: 180, b: 20 } } }).png().toBuffer());
  }
  const filename = path.join(folder, 'dataset.json');
  await fs.writeFile(filename, JSON.stringify(data));
  return { folder, filename, data };
}

test('field scoring uses values, case and leading zeros rather than completion/review status', () => {
  const document = { id: 'doc-1', documentType: 'student_certificate', expectedFields: expected() };
  const response = result(document, { fields: { ...expected(), facultyNumber: '120001', fullName: 'тестов Студент 1' } });
  const scores = scoreFields(document.expectedFields, validateResult(response, document));
  assert.equal(scores.facultyNumber.matched, false);
  assert.equal(scores.fullName.matched, false);
  assert.equal(scores.specialty.matched, true);
  const reviewed = result(document, { status: 'partial', requiresManualReview: true, fieldIssues: [{ field: 'fullName', code: 'uncertain', message: 'Review' }] });
  assert.ok(Object.values(scoreFields(document.expectedFields, validateResult(reviewed, document))).every((score) => score.matched));
});

test('comparison allows only declared whitespace/NFC normalization and never fixes OCR characters', () => {
  const target = { ...expected(), fullName: 'Йордан Иванов', facultyNumber: '001234567' };
  const response = { fields: { ...target, fullName: ' И\u0306ордан\tИванов ', facultyNumber: '0012З4567' }, fieldIssues: [] };
  const scores = scoreFields(target, response);
  assert.equal(scores.fullName.matched, true);
  assert.equal(scores.facultyNumber.matched, false);
  assert.ok(!JSON.stringify(scores).includes('Йордан'));
});

test('known absences are scored separately and failures never earn null matches', () => {
  const target = { ...expected(), specialty: null };
  const response = { fields: { ...target }, fieldIssues: [{ field: 'specialty', code: 'missing', message: 'Missing' }] };
  assert.equal(scoreFields(target, response).specialty.matched, true);
  assert.equal(scoreFields(target, response).specialty.expectedPresent, false);
  assert.ok(Object.values(scoreFields(target, null)).every((score) => !score.matched));
  const hallucinated = scoreFields(target, { ...response, fields: { ...target, specialty: 'Invented' } });
  assert.equal(hallucinated.specialty.matched, false);
  assert.equal(hallucinated.specialty.actualPresent, true);
});

test('timing distributions use nearest-rank p95 and keep failures/incomplete coverage visible', () => {
  assert.deepEqual(distribution([1000, 2000, 3000, 40000]), { count: 4, meanMs: 11500, medianMs: 2500, p95Ms: 40000, minMs: 1000, maxMs: 40000 });
  const row = { id: 'x', quality: 'clean', state: 'success', fields: scoreFields(expected(), { fields: expected(), fieldIssues: [] }), timings: { totalMs: 1000 }, requiresManualReview: false };
  const error = { ...row, state: 'error', fields: scoreFields(expected(), null), timings: { totalMs: 40000 } };
  const summary = summarize([row, error]);
  assert.equal(summary.fields.accuracy, 0.5);
  assert.equal(summary.timings.totalMs.p95Ms, 40000);
  assert.equal(summary.earlyTargets.allDocumentsSuccessfullyWithin15s, false);
  const incomplete = summarize([row, { ...error, state: 'not_attempted', timings: { totalMs: null } }]);
  assert.equal(incomplete.fields.total, 8);
  assert.equal(incomplete.fields.accuracy, 0.5);
  assert.equal(incomplete.earlyTargets.fieldAccuracyAtLeast90Percent, null);
  assert.equal(incomplete.earlyTargets.finalAcceptanceAssessed, false);
  assert.equal(summarize([{ ...error, state: 'cancelled' }], { aborted: true }).earlyTargets.fieldAccuracyAtLeast90Percent, null);
});

test('manifest checks require ten samples, unique IDs, exact field types and portable paths', () => {
  validateManifest(manifest());
  for (const change of [
    (value) => value.documents.pop(),
    (value) => { value.documents[1].id = value.documents[0].id; },
    (value) => { value.documents[0].file = '../private.pdf'; },
    (value) => { value.documents[0].documentType = 'placement_order'; },
    (value) => { value.documents[0].expectedFields.facultyNumber = 123; },
    (value) => { value.documents[0].expectedFields.yearOfStudy = 'II'; },
    (value) => { value.documents[0].expectedFields.egn = 'extra'; },
  ]) {
    const value = manifest(); change(value);
    assert.throws(() => validateManifest(value), EvaluationError);
  }
  const literalSourceError = manifest();
  literalSourceError.documents[0].expectedFields.yearOfStudy = 9;
  validateManifest(literalSourceError); // Recognition truth is not application eligibility.
});

test('loads real file hashes and rejects duplicate content and MIME mismatches', async (t) => {
  const data = await fixture(t);
  const dataset = await loadDataset(data.filename, config());
  assert.equal(dataset.documents.length, 10);
  assert.equal(new Set(dataset.documents.map((item) => item.sha256)).size, 10);
  data.data.documents[0].mimeType = 'image/jpeg';
  await fs.writeFile(data.filename, JSON.stringify(data.data));
  await assert.rejects(loadDataset(data.filename, config()), /fails file or limit checks/);
  data.data.documents[0].mimeType = 'image/png';
  await fs.writeFile(data.filename, JSON.stringify(data.data));
  await fs.copyFile(path.join(data.folder, data.data.documents[0].file), path.join(data.folder, data.data.documents[1].file));
  await assert.rejects(loadDataset(data.filename, config()), /Duplicate document/);
});

test('evaluation counts every planned field, retains partial correct values and observes stage timings', async (t) => {
  const data = await fixture(t);
  const dataset = await loadDataset(data.filename, config());
  const targets = new Map(dataset.documents.map((document) => [document.id, document]));
  let calls = 0;
  const report = await runEvaluation(dataset, config(), { processDocument: async (input, { onTiming }) => {
    assert.ok(!Object.hasOwn(input, 'expectedFields'));
    calls += 1;
    onTiming({ preprocessingMs: 1, aiMs: 2, validationMs: 1, totalMs: 4 });
    const document = targets.get(input.documentId);
    if (calls === 1) throw new ApiError(503, 'provider_unavailable', 'private-provider-body', { retryable: true });
    return result(document, { status: 'partial', requiresManualReview: true, fieldIssues: [{ field: 'fullName', code: 'uncertain', message: 'private-value-not-to-report' }] });
  } });
  assert.equal(report.summary.fields.correct, 36);
  assert.equal(report.summary.fields.total, 40);
  assert.equal(report.summary.failedDocuments, 1);
  assert.equal(report.summary.reviewRequiredDocuments, 9);
  assert.equal(report.summary.timings.aiMs.count, 10);
  assert.ok(!JSON.stringify(report).includes('test-not-a-real-key'));
  assert.ok(!JSON.stringify(report).includes('Тестов Студент'));
  assert.ok(!JSON.stringify(report).includes('private-provider-body'));
  assert.match(markdownReport(report), /36\/40/);
  assert.match(markdownReport(report), /fullName: uncertain/);
  assert.equal(report.summary.byField.fullName.issueCounts.uncertain, 9);
});

test('fatal configuration aborts remaining documents without inflating accuracy', async (t) => {
  const data = await fixture(t);
  const dataset = await loadDataset(data.filename, config());
  const report = await runEvaluation(dataset, config(), { processDocument: async () => { throw new ApiError(503, 'provider_configuration_error', 'Unavailable'); } });
  assert.equal(report.summary.attemptedDocuments, 1);
  assert.equal(report.summary.notAttemptedDocuments, 9);
  assert.equal(report.summary.fields.total, 40);
  assert.equal(report.summary.fields.correct, 0);
  assert.equal(report.summary.earlyTargets.fieldAccuracyAtLeast90Percent, null);
});

test('a provider Retry-After stops the batch instead of immediately calling the next document', async (t) => {
  const data = await fixture(t);
  const dataset = await loadDataset(data.filename, config());
  let calls = 0;
  const report = await runEvaluation(dataset, config(), { processDocument: async () => {
    calls += 1;
    throw new ApiError(503, 'provider_unavailable', 'Unavailable', { retryable: true, details: { retryAfterSeconds: 120 } });
  } });
  assert.equal(calls, 1);
  assert.equal(report.abortCode, 'provider_retry_after');
  assert.equal(report.documents[0].retryAfterSeconds, 120);
  assert.equal(report.summary.notAttemptedDocuments, 9);
  assert.equal(report.summary.earlyTargets.fieldAccuracyAtLeast90Percent, null);
  assert.match(markdownReport(report), /retry after 120s/);
});

test('mock configuration/results are rejected and source changes invalidate the run', async (t) => {
  const data = await fixture(t);
  const dataset = await loadDataset(data.filename, config());
  await assert.rejects(runEvaluation(dataset, config({ AI_PROVIDER: 'mock' })), /Mock mode is not OCR/);
  await assert.rejects(runEvaluation(dataset, config(), { processDocument: async (input) => result({ id: input.documentId, expectedFields: expected() }, { status: 'partial', requiresManualReview: true, warnings: ['mock_result'] }) }), (error) => error.code === 'mock_result');
  await fs.appendFile(dataset.documents[0].filePath, 'changed');
  const report = await runEvaluation(dataset, config(), { processDocument: async () => { throw new Error('Must not run'); } });
  assert.equal(report.abortCode, 'dataset_changed');
  assert.equal(report.summary.fields.correct, 0);
  await fs.unlink(dataset.documents[0].filePath);
  const removed = await runEvaluation(dataset, config(), { processDocument: async () => { throw new Error('Must not run'); } });
  assert.equal(removed.abortCode, 'invalid_dataset');
  assert.equal(removed.summary.notAttemptedDocuments, 9);
  assert.equal(removed.summary.earlyTargets.fieldAccuracyAtLeast90Percent, null);
});

test('public-result shape errors cannot become successful field measurements', () => {
  const document = { id: 'id', documentType: 'student_certificate', expectedFields: expected() };
  assert.throws(() => validateResult(result(document, { fields: { ...expected(), yearOfStudy: '2' } }), document), /invalid field types/);
  assert.throws(() => validateResult(result(document, { requiresManualReview: true }), document), /inconsistent review/);
});

test('timing observation reports both successes and failures without changing public results', async () => {
  const settings = config({ AI_PROVIDER: 'mock' });
  const prepared = { status: 'prepared', pages: [] };
  let timing;
  const processor = createDocumentProcessor(settings, { prepare: async () => prepared });
  const output = await processor({ documentId: 'timing-test', documentType: 'student_certificate' }, { onTiming: (value) => { timing = value; } });
  assert.equal(output.status, 'partial');
  assert.ok(!Object.hasOwn(output, 'timings'));
  for (const value of Object.values(timing)) assert.ok(value >= 0);
  const failed = createDocumentProcessor(settings, { prepare: async () => { throw new ApiError(415, 'unsupported_file', 'Invalid'); } });
  await assert.rejects(failed({ documentType: 'student_certificate' }, { onTiming: (value) => { timing = value; } }), (error) => error.code === 'unsupported_file');
  assert.ok(timing.preprocessingMs >= 0);
  assert.equal(timing.aiMs, null);
  const safe = await processor({ documentId: 'observer-test', documentType: 'student_certificate' }, { onTiming: () => { throw new Error('Observer failed'); } });
  assert.equal(safe.documentId, 'observer-test');
});

test('validation-only CLI works with mock/empty AI credentials and produces no accuracy report', async (t) => {
  const data = await fixture(t);
  const command = await execute(process.execPath, [path.join(ROOT, 'scripts/evaluate.js'), '--dataset', data.filename, '--validate-only'], {
    cwd: ROOT, env: { ...process.env, AI_PROVIDER: 'mock', OPENAI_API_KEY: '', OPENAI_MODEL: '' }, timeout: 20000,
  });
  const validation = JSON.parse(command.stdout);
  assert.equal(validation.documents, 10);
  assert.equal(validation.providerCalls, 0);
  assert.equal(validation.mode, 'dataset-validation-only');
  assert.ok(!Object.hasOwn(validation, 'accuracy'));
});

test('cancellation keeps unattempted cases visible and explicit value inclusion is opt-in', async (t) => {
  const data = await fixture(t);
  const dataset = await loadDataset(data.filename, config());
  const controller = new AbortController();
  const report = await runEvaluation(dataset, config(), { signal: controller.signal, processDocument: async () => {
    controller.abort();
    throw new DOMException('Cancelled', 'AbortError');
  } });
  assert.equal(report.documents[0].state, 'cancelled');
  assert.equal(report.summary.notAttemptedDocuments, 9);
  assert.equal(report.summary.fields.correct, 0);
  assert.equal(report.summary.earlyTargets.fieldAccuracyAtLeast90Percent, null);
  const scores = scoreFields(expected(), { fields: expected(), fieldIssues: [] }, { includeValues: true });
  assert.equal(scores.fullName.expected, expected().fullName);
  assert.equal(scores.facultyNumber.actual, expected().facultyNumber);
});

test('CLI writes honest incomplete reports and refuses to overwrite them', async (t) => {
  const data = await fixture(t);
  const output = path.join(data.folder, 'reports');
  const args = [path.join(ROOT, 'scripts/evaluate.js'), '--dataset', data.filename, '--output-dir', output];
  const options = { cwd: ROOT, timeout: 20000, env: {
    ...process.env, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-not-a-real-key', OPENAI_MODEL: 'test-model',
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', PYTHON_COMMAND: 'missing-evaluation-python-for-test',
  } };
  await assert.rejects(execute(process.execPath, args, options), (error) => error.code === 1);
  const original = await fs.readFile(path.join(output, 'report.json'), 'utf8');
  const report = JSON.parse(original);
  assert.equal(report.abortCode, 'processing_not_configured');
  assert.equal(report.summary.notAttemptedDocuments, 9);
  assert.equal(report.summary.earlyTargets.fieldAccuracyAtLeast90Percent, null);
  assert.ok((await fs.readFile(path.join(output, 'report.md'), 'utf8')).includes('not attempted: 9'));
  await assert.rejects(execute(process.execPath, args, options), (error) => error.code === 2);
  assert.equal(await fs.readFile(path.join(output, 'report.json'), 'utf8'), original);
});
