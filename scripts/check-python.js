const path = require('node:path');
const dotenv = require('dotenv');
const { loadConfig } = require('../src/config/env');
const { createPythonPreprocessor } = require('../src/services/document-processing/python-preprocessor');
const { ApiError } = require('../src/errors/api-error');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

async function main() {
  const config = loadConfig();
  const example = require('../openapi.json').paths['/api/v1/ocr/process'].post.requestBody.content['application/json'].examples.transportExample.value;
  const result = await createPythonPreprocessor(config)({
    buffer: Buffer.from(example.file.contentBase64, 'base64'),
    mimeType: example.file.mimeType,
    metadata: { pageCount: 1 },
  });
  const summary = { status: result.status, pageCount: result.pageCount, pages: result.pages.map(({ contentBase64, ...metadata }) => metadata) };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Python integration check failed. Check configuration.');
  process.exitCode = 1;
});
