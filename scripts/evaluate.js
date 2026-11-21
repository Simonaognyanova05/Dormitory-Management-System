const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const dotenv = require('dotenv');
const { loadConfig } = require('../src/config/env');
const { EvaluationError, loadDataset } = require('../src/evaluation/dataset');
const { assertEvaluationConfig, runEvaluation } = require('../src/evaluation/run-evaluation');
const { markdownReport } = require('../src/evaluation/scoring');

const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      dataset: { type: 'string' }, 'output-dir': { type: 'string' },
      'validate-only': { type: 'boolean', default: false }, 'include-values': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    }, strict: true, allowPositionals: false }));
  } catch {
    throw new EvaluationError('Invalid evaluation arguments. Use --help.', 'evaluation_config');
  }
  if (values.help) {
    console.log('Usage: npm run evaluate -- --dataset <dataset.json> [--validate-only] [--output-dir <new folder>] [--include-values]');
    console.log('Live evaluation requires AI_PROVIDER=openai and makes provider calls. Validation-only makes none.');
    return;
  }
  if (!values.dataset) throw new EvaluationError('Supply --dataset <dataset.json>.', 'evaluation_config');
  const config = loadConfig();
  const dataset = await loadDataset(values.dataset, config);
  if (values['validate-only']) {
    const present = dataset.documents.reduce((sum, document) => sum + Object.values(document.expectedFields).filter((value) => value !== null).length, 0);
    console.log(JSON.stringify({ mode: 'dataset-validation-only', datasetId: dataset.datasetId, documents: dataset.documents.length, fieldSlots: dataset.documents.length * 4, knownPresentFields: present, knownAbsentFields: dataset.documents.length * 4 - present, providerCalls: 0 }, null, 2));
    return;
  }
  assertEvaluationConfig(config);
  const output = path.resolve(values['output-dir'] || path.join(ROOT, 'tmp', `evaluation-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  try {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.mkdir(output); // Refuse existing output directories before making provider calls.
  } catch {
    throw new EvaluationError('Use a new writable --output-dir; existing reports are never overwritten.', 'evaluation_config');
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const report = await runEvaluation(dataset, config, {
      signal: controller.signal, includeValues: values['include-values'],
      onProgress: ({ id, state, errorCode }) => console.log(`${id}: ${state}${errorCode ? ` (${errorCode})` : ''}`),
    });
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    await fs.writeFile(path.join(output, 'report.md'), markdownReport(report), { flag: 'wx' });
    console.log(`Report saved: ${output}`);
    console.log(`Fields: ${report.summary.fields.correct}/${report.summary.fields.total}; successful documents: ${report.summary.successfulDocuments}/${report.summary.requestedDocuments}.`);
    if (controller.signal.aborted) process.exitCode = 130;
    else if (report.aborted || report.summary.failedDocuments) process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

main().catch((error) => {
  console.error(error instanceof EvaluationError ? error.message : 'Evaluation failed. Check configuration, input files and output permissions.');
  process.exitCode = 2;
});
