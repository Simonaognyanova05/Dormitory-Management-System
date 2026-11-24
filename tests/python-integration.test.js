const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const dotenv = require('dotenv');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config/env');
const { createPythonPreprocessor } = require('../src/services/document-processing/python-preprocessor');

const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
const localPython = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const config = loadConfig({ ...process.env, SERVICE_TOKEN: 'python-integration-token', PYTHON_COMMAND: process.env.PYTHON_COMMAND || (fs.existsSync(localPython) ? localPython : 'python') });

function image(color) {
  return sharp({ create: { width: 40, height: 60, channels: 3, background: color } }).png().toBuffer();
}

async function firstPixel(page) {
  const raw = await sharp(Buffer.from(page.contentBase64, 'base64')).raw().toBuffer();
  return [...raw.subarray(0, 3)];
}

test('real Python prepares simultaneous documents without mixing image content', async () => {
  const prepare = createPythonPreprocessor(config);
  const sources = await Promise.all([image('red'), image('blue')]);
  const results = await Promise.all(sources.map((buffer) => prepare({ buffer, mimeType: 'image/png', metadata: { pageCount: 1 } })));
  assert.deepEqual(await firstPixel(results[0].pages[0]), [255, 0, 0]);
  assert.deepEqual(await firstPixel(results[1].pages[0]), [0, 0, 255]);
});

test('real Python renders an image-only PDF and preserves its page order', async () => {
  const document = await PDFDocument.create();
  for (const color of ['red', 'blue']) {
    const png = await document.embedPng(await image(color));
    document.addPage([200, 300]).drawImage(png, { x: 0, y: 0, width: 200, height: 300 });
  }
  const result = await createPythonPreprocessor(config)({ buffer: Buffer.from(await document.save()), mimeType: 'application/pdf', metadata: { pageCount: 2 } });
  assert.equal(result.pageCount, 2);
  assert.deepEqual(await firstPixel(result.pages[0]), [255, 0, 0]);
  assert.deepEqual(await firstPixel(result.pages[1]), [0, 0, 255]);
});

test('real Python input errors are mapped back to the safe API envelope', async () => {
  await assert.rejects(createPythonPreprocessor(config)({ buffer: Buffer.from('private-invalid-image'), mimeType: 'image/png' }), (error) => {
    assert.equal(error.status, 415);
    assert.equal(error.code, 'unsupported_file');
    assert.ok(!error.message.includes('private-invalid-image'));
    return true;
  });
});

test('the live HTTP pipeline prepares images and returns explicitly marked mock extraction', async (t) => {
  const mockConfig = loadConfig({ ...process.env, SERVICE_TOKEN: 'python-integration-token', PYTHON_COMMAND: config.pythonCommand, AI_PROVIDER: 'mock', OPENAI_API_KEY: '', OPENAI_MODEL: '' });
  const server = createApp({ config: mockConfig }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/ocr/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': 'python-integration-token' },
    body: JSON.stringify({ documentId: 'real-python-test', documentType: 'student_certificate', file: { mimeType: 'image/png', contentBase64: (await image('white')).toString('base64') } }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ocr-ai-provider'), 'mock');
  const result = await response.json();
  assert.equal(result.fields.facultyNumber, '001234567');
  assert.deepEqual(result.warnings, ['mock_result']);
  assert.equal(result.status, 'partial');
  assert.equal(result.requiresManualReview, true);
});

test('real Python processes concurrent certificate/order requests without mixing their profiles', async (t) => {
  const mockConfig = loadConfig({ ...process.env, SERVICE_TOKEN: 'python-integration-token', PYTHON_COMMAND: config.pythonCommand, AI_PROVIDER: 'mock', OPENAI_API_KEY: '', OPENAI_MODEL: '' });
  const server = createApp({ config: mockConfig }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const png = (await image('white')).toString('base64');
  const results = await Promise.all(['student_certificate', 'placement_order'].map(async (documentType) => {
    const reply = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/ocr/process`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Token': 'python-integration-token' },
      body: JSON.stringify({ documentId: documentType, documentType, file: { mimeType: 'image/png', contentBase64: png } }),
    });
    assert.equal(reply.status, 200);
    return reply.json();
  }));
  assert.equal(results[0].documentType, 'student_certificate');
  assert.equal(results[0].fields.facultyNumber, '001234567');
  assert.equal(results[1].documentType, 'placement_order');
  assert.deepEqual(results[1].fields, { orderNumber: 'РД-001', orderDate: '2026-11-03', dormitory: '01', room: '012А' });
  assert.deepEqual(results[1].warnings, ['mock_result']);
  assert.equal(results[1].status, 'partial');
});
