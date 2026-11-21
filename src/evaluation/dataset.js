const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isUtf8 } = require('node:buffer');
const { FIELD_NAMES } = require('../services/ai/certificate-profile');
const { inspectDocumentFile } = require('../validators/document-file');

class EvaluationError extends Error {
  constructor(message, code = 'invalid_dataset') {
    super(message);
    this.name = 'EvaluationError';
    this.code = code;
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalValue(field, value) {
  if (typeof value !== 'string') return value;
  const text = value.normalize('NFC').trim();
  return field === 'facultyNumber' ? text : text.replace(/\s+/gu, ' ');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readBoundedFile(filename, maximum) {
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size === 0 || stat.size > maximum) throw new EvaluationError('Dataset file is empty, oversized or not a regular file.');
    const bytes = await fs.readFile(filename);
    if (bytes.length !== stat.size || bytes.length > maximum) throw new EvaluationError('Dataset file changed while being read.');
    return bytes;
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    throw new EvaluationError('Could not read a dataset file. Check the manifest and local paths.');
  }
}

function validateManifest(value) {
  const required = ['schemaVersion', 'datasetId', 'synthetic', 'documents'];
  const allowed = [...required, 'description', 'language'];
  if (!record(value) || !required.every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.includes(key))
    || value.schemaVersion !== 1 || typeof value.synthetic !== 'boolean'
    || typeof value.datasetId !== 'string' || value.datasetId.trim() !== value.datasetId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.datasetId)
    || !Array.isArray(value.documents) || value.documents.length < 10
    || (value.description !== undefined && typeof value.description !== 'string')
    || (value.language !== undefined && typeof value.language !== 'string')) {
    throw new EvaluationError('Use schemaVersion 1, a dataset ID, synthetic boolean and at least 10 documents.');
  }
  const ids = new Set();
  let presentFields = 0;
  for (const item of value.documents) {
    if (!exactKeys(item, ['id', 'file', 'mimeType', 'documentType', 'quality', 'expectedFields'])
      || typeof item.id !== 'string' || item.id.trim() !== item.id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.id) || ids.has(item.id)
      || item.documentType !== 'student_certificate' || !['application/pdf', 'image/png', 'image/jpeg'].includes(item.mimeType)
      || typeof item.quality !== 'string' || item.quality.trim() !== item.quality || !/^[A-Za-z0-9_-]{1,64}$/.test(item.quality)
      || typeof item.file !== 'string' || !item.file || path.isAbsolute(item.file)
      || /[:\\]/.test(item.file) || item.file.split('/').some((part) => !part || part === '..' || part === '.')
      || !exactKeys(item.expectedFields, FIELD_NAMES)) {
      throw new EvaluationError('Each document needs a unique ID, relative file path, supported certificate type, quality label and all four expected fields.');
    }
    ids.add(item.id);
    for (const field of FIELD_NAMES) {
      const candidate = item.expectedFields[field];
      if (candidate === null) continue;
      if (field === 'yearOfStudy' ? !Number.isSafeInteger(candidate) : typeof candidate !== 'string' || !canonicalValue(field, candidate)) {
        throw new EvaluationError('Expected fields must use strings, a safe integer year, or explicit null for absent values.');
      }
      presentFields += 1;
    }
  }
  if (!presentFields) throw new EvaluationError('A recognition dataset must contain known present values, not only absent-field controls.');
}

async function loadDataset(filename, config) {
  const manifestPath = path.resolve(filename);
  const bytes = await readBoundedFile(manifestPath, 1024 * 1024);
  if (!isUtf8(bytes)) throw new EvaluationError('Dataset manifest must use UTF-8.');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch { throw new EvaluationError('Dataset manifest is not valid JSON.'); }
  validateManifest(manifest);
  const hashes = new Set();
  const documents = [];
  for (const item of manifest.documents) {
    const filePath = path.resolve(path.dirname(manifestPath), item.file);
    const content = await readBoundedFile(filePath, config.limits.maxFileBytes);
    const hash = sha256(content);
    if (hashes.has(hash)) throw new EvaluationError('Duplicate document contents cannot count as distinct benchmark samples.');
    hashes.add(hash);
    let metadata;
    try { metadata = await inspectDocumentFile({ buffer: content, mimeType: item.mimeType }, config.limits); }
    catch { throw new EvaluationError(`Dataset document ${item.id} fails file or limit checks.`); }
    documents.push({
      ...item, filePath, sha256: hash, sizeBytes: content.length, pageCount: metadata.pageCount,
      expectedFields: Object.fromEntries(FIELD_NAMES.map((field) => [field, canonicalValue(field, item.expectedFields[field])])),
    });
  }
  return {
    datasetId: manifest.datasetId, synthetic: manifest.synthetic, language: manifest.language || 'unspecified',
    manifestSha256: sha256(bytes), documents,
  };
}

module.exports = { EvaluationError, record, exactKeys, canonicalValue, sha256, readBoundedFile, validateManifest, loadDataset };
