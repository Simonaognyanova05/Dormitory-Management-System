const { FIELD_NAMES, DETECTED_TYPES } = require('../services/ai/certificate-profile');
const { EvaluationError, exactKeys, canonicalValue } = require('./dataset');

function validateResult(result, document) {
  if (!exactKeys(result, ['documentId', 'documentType', 'detectedDocumentType', 'status', 'fields', 'fieldIssues', 'warnings', 'requiresManualReview'])
    || result.documentId !== document.id || result.documentType !== document.documentType
    || !DETECTED_TYPES.filter((type) => type !== 'medical').includes(result.detectedDocumentType)
    || !['completed', 'partial'].includes(result.status) || !exactKeys(result.fields, FIELD_NAMES)
    || !Array.isArray(result.fieldIssues) || !Array.isArray(result.warnings)) {
    throw new EvaluationError('The processor returned an invalid public result.', 'invalid_result');
  }
  if (result.warnings.includes('mock_result')) throw new EvaluationError('Mock results cannot be reported as recognition measurements.', 'mock_result');
  if (!result.warnings.every((warning) => warning === 'document_type_mismatch')
    || !result.fieldIssues.every((issue) => exactKeys(issue, ['field', 'code', 'message']) && FIELD_NAMES.includes(issue.field)
      && ['missing', 'invalid_format', 'uncertain'].includes(issue.code) && typeof issue.message === 'string')) {
    throw new EvaluationError('The processor returned unsupported issues or warnings.', 'invalid_result');
  }
  for (const field of FIELD_NAMES) {
    const actual = result.fields[field];
    if (actual !== null && (field === 'yearOfStudy' ? !Number.isSafeInteger(actual) : typeof actual !== 'string' || !actual.length)) {
      throw new EvaluationError('The processor returned invalid field types.', 'invalid_result');
    }
    if (actual === null && !result.fieldIssues.some((issue) => issue.field === field)) {
      throw new EvaluationError('Null fields require review issues.', 'invalid_result');
    }
  }
  const needsReview = result.fieldIssues.length > 0 || result.warnings.length > 0;
  if (result.requiresManualReview !== needsReview || result.status !== (needsReview ? 'partial' : 'completed')) {
    throw new EvaluationError('The processor returned inconsistent review status.', 'invalid_result');
  }
  return result;
}

function scoreFields(expected, result, { includeValues = false } = {}) {
  return Object.fromEntries(FIELD_NAMES.map((field) => {
    const available = result !== null;
    const actual = available ? result.fields[field] : undefined;
    const matched = available && canonicalValue(field, actual) === canonicalValue(field, expected[field]);
    const score = {
      matched, expectedPresent: expected[field] !== null,
      actualPresent: available ? actual !== null : null,
      issueCodes: available ? [...new Set(result.fieldIssues.filter((issue) => issue.field === field).map((issue) => issue.code))] : [],
    };
    if (includeValues) { score.expected = expected[field]; score.actual = available ? actual : null; }
    return [field, score];
  }));
}

function distribution(values) {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, meanMs: null, medianMs: null, p95Ms: null, minMs: null, maxMs: null };
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], minMs: sorted[0], maxMs: sorted.at(-1),
  };
}

function counts(scores) {
  const total = scores.length;
  const correct = scores.filter((score) => score.matched).length;
  const present = scores.filter((score) => score.expectedPresent);
  const absent = scores.filter((score) => !score.expectedPresent);
  return {
    total, correct, accuracy: total ? correct / total : null,
    present: { total: present.length, correct: present.filter((score) => score.matched).length, accuracy: present.length ? present.filter((score) => score.matched).length / present.length : null },
    absent: { total: absent.length, correct: absent.filter((score) => score.matched).length, hallucinated: absent.filter((score) => score.actualPresent === true).length },
    issueCounts: Object.fromEntries(['missing', 'invalid_format', 'uncertain'].map((code) => [code, scores.filter((score) => score.issueCodes.includes(code)).length])),
  };
}

function summarize(rows, { aborted = false } = {}) {
  const allScores = rows.flatMap((row) => Object.values(row.fields));
  const attempted = rows.filter((row) => row.state !== 'not_attempted');
  const successful = rows.filter((row) => row.state === 'success');
  const overall = counts(allScores);
  const completeRun = attempted.length === rows.length && !aborted;
  const successfulWithin15s = successful.filter((row) => row.timings.totalMs <= 15000).length;
  return {
    requestedDocuments: rows.length, attemptedDocuments: attempted.length, successfulDocuments: successful.length,
    failedDocuments: attempted.length - successful.length, notAttemptedDocuments: rows.length - attempted.length,
    completeRun, allValuesCorrectDocuments: successful.filter((row) => Object.values(row.fields).every((score) => score.matched)).length,
    reviewRequiredDocuments: successful.filter((row) => row.requiresManualReview).length,
    resultStatuses: { completed: successful.filter((row) => row.resultStatus === 'completed').length, partial: successful.filter((row) => row.resultStatus === 'partial').length },
    documentTypeMismatches: successful.filter((row) => row.warnings?.includes('document_type_mismatch')).length,
    fields: overall,
    byField: Object.fromEntries(FIELD_NAMES.map((field) => [field, counts(rows.map((row) => row.fields[field]))])),
    byQuality: Object.fromEntries([...new Set(rows.map((row) => row.quality))].map((quality) => [quality, counts(rows.filter((row) => row.quality === quality).flatMap((row) => Object.values(row.fields)))])),
    timings: Object.fromEntries(['admissionMs', 'preprocessingMs', 'aiMs', 'validationMs', 'totalMs'].map((key) => [key, distribution(attempted.map((row) => row.timings[key]))])),
    successfulTiming: distribution(successful.map((row) => row.timings.totalMs)),
    earlyTargets: {
      minimumTenDocuments: rows.length >= 10,
      fieldAccuracyAtLeast90Percent: completeRun ? overall.accuracy >= 0.9 : null,
      successfulWithin15s, allDocumentsSuccessfullyWithin15s: completeRun ? successfulWithin15s === rows.length : null,
      finalAcceptanceAssessed: false,
    },
  };
}

function markdownReport(report) {
  const percent = (value) => value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
  const seconds = (value) => value === null ? 'n/a' : `${(value / 1000).toFixed(3)} s`;
  const summary = report.summary;
  const lines = [
    '# Early OCR Evaluation', '',
    `Dataset: **${report.dataset.datasetId}** (${report.dataset.synthetic ? 'synthetic' : 'operator supplied'}; ${report.dataset.documents} documents).`,
    `Provider/model: **${report.provider.name} / ${report.provider.model}**.`,
    `Attempted: ${summary.attemptedDocuments}; successful: ${summary.successfulDocuments}; failed: ${summary.failedDocuments}; not attempted: ${summary.notAttemptedDocuments}.`, '',
    ...(report.aborted ? [`Run stopped: **${report.abortCode}**. Remaining documents stay unattempted; target indicators are not assessed.`, ''] : []),
    `All-field accuracy: **${percent(summary.fields.accuracy)}** (${summary.fields.correct}/${summary.fields.total}).`,
    `Present-field accuracy: **${percent(summary.fields.present.accuracy)}**. Correct absences: ${summary.fields.absent.correct}/${summary.fields.absent.total}; hallucinated absent values: ${summary.fields.absent.hallucinated}.`,
    `Overall median / p95: **${seconds(summary.timings.totalMs.medianMs)} / ${seconds(summary.timings.totalMs.p95Ms)}** (all attempted documents, including failures).`,
    `Successful documents within 15 s: **${summary.earlyTargets.successfulWithin15s}/${summary.requestedDocuments}**.`, '',
    'This is an early certificate-only check, not final 30-document acceptance. Value matches are independent of completed/partial status and review flags.', '',
    '## Per field', '', '| Field | Correct / total | Accuracy | Present accuracy |', '| --- | --- | --- | --- |',
  ];
  for (const [field, value] of Object.entries(summary.byField)) lines.push(`| ${field} | ${value.correct}/${value.total} | ${percent(value.accuracy)} | ${percent(value.present.accuracy)} |`);
  lines.push('', '## Timings', '', '| Stage | Count | Mean | Median | p95 |', '| --- | --- | --- | --- | --- |');
  for (const [stage, value] of Object.entries(summary.timings)) lines.push(`| ${stage} | ${value.count} | ${seconds(value.meanMs)} | ${seconds(value.medianMs)} | ${seconds(value.p95Ms)} |`);
  lines.push('', '## Documents', '', '| ID | Quality | State | Correct / 4 | Total | Issues / error |', '| --- | --- | --- | --- | --- | --- |');
  for (const row of report.documents) {
    const issues = Object.entries(row.fields).flatMap(([field, score]) => {
      const notes = [...(score.matched ? [] : ['value mismatch']), ...score.issueCodes];
      return notes.length ? [`${field}: ${notes.join(', ')}`] : [];
    });
    const failure = row.errorCode ? `${row.errorCode}${row.retryAfterSeconds ? ` (retry after ${row.retryAfterSeconds}s)` : ''}` : null;
    lines.push(`| ${row.id} | ${row.quality} | ${row.state}${row.resultStatus ? ` / ${row.resultStatus}` : ''} | ${Object.values(row.fields).filter((score) => score.matched).length}/4 | ${seconds(row.timings.totalMs)} | ${failure || [...issues, ...(row.warnings || [])].join('; ') || 'none'} |`);
  }
  lines.push('', 'Comparison: NFC and boundary whitespace; collapse name/specialty whitespace only. Case, spelling, leading zeros and field types remain significant. Missing pipeline results score zero for every field, including annotated absences.', 'p95 uses nearest rank. Disk reads/Base64 encoding, HTTP upload and streaming JSON parsing are outside the measured boundary. Admission, Python, AI retries and field validation are included.', 'See the JSON report for hashes, configuration provenance, stage times, quality groups and field-level outcomes.', '');
  return lines.join('\n');
}

module.exports = { validateResult, scoreFields, distribution, summarize, markdownReport };
