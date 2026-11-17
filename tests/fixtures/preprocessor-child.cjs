// A real subprocess with controllable protocol failures. It is not an OCR mock.
const mode = process.argv[2];
const png = require('../../openapi.json').paths['/api/v1/ocr/process'].post.requestBody.content['application/json'].examples.transportExample.value.file.contentBase64;

function prepared() {
  return {
    status: 'prepared', pageCount: 1,
    pages: [{
      pageNumber: 1, mimeType: 'image/png', width: 1, height: 1, contentBase64: png,
      transforms: {
        exifOrientationApplied: false, pdfRotationDegrees: 0, manualRotationClockwiseDegrees: 0,
        deskewCounterClockwiseDegrees: 0, resized: false, contrastEnhanced: false, denoised: false,
      },
    }],
  };
}

if (mode === 'early-success') {
  process.stdin.destroy();
  process.stdout.write(JSON.stringify(prepared()));
} else {
  process.stdin.resume();
  process.stdin.once('end', () => {
    const result = prepared();
    switch (mode) {
      case 'bad-json': process.stdout.write('private-worker-content: not JSON'); return;
      case 'two-json': process.stdout.write(`${JSON.stringify(result)}\n${JSON.stringify(result)}`); return;
      case 'import-failure': process.stderr.write('private-worker-content: missing import'); process.exitCode = 1; return;
      case 'flood-stdout': process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000); return;
      case 'flood-stderr': process.stderr.write('x'.repeat(8192)); setInterval(() => {}, 1000); return;
      case 'hang': process.on('SIGTERM', () => {}); process.stderr.write('ready'); setInterval(() => {}, 1000); return;
      case 'known-error':
      case 'unknown-error':
      case 'invalid-error-code':
        process.stdout.write(JSON.stringify({ error: {
          code: mode === 'known-error' ? 'unsupported_file' : mode === 'unknown-error' ? 'unknown_private_code' : { toString: {} },
          message: 'private-worker-content', retryable: false, details: { private: 'private-worker-content' },
        } }));
        process.exitCode = 2;
        return;
      case 'bad-dimensions': result.pages[0].width = 2; break;
      case 'bad-order': result.pages[0].pageNumber = 2; break;
      case 'bad-count': result.pageCount = 2; break;
      case 'bad-base64': result.pages[0].contentBase64 = '!!!!'; break;
      case 'bad-pixels': result.pages[0].contentBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'); break;
      case 'bad-transforms': delete result.pages[0].transforms.resized; break;
      case 'extra-root': result.private = 'private-worker-content'; break;
      case 'success-with-error-exit': process.exitCode = 2; break;
      case 'with-diagnostics': process.stderr.write('private-worker-content'); break;
      default: break;
    }
    const json = JSON.stringify(result);
    if (mode === 'chunked') {
      let offset = 0;
      const timer = setInterval(() => {
        process.stdout.write(json.slice(offset, offset + 37));
        offset += 37;
        if (offset >= json.length) clearInterval(timer);
      }, 1);
    } else {
      process.stdout.write(json);
    }
  });
}
