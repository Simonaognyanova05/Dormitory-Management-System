const { performance } = require('node:perf_hooks');
const { ApiError } = require('../../errors/api-error');
const { requireCertificate } = require('./certificate-profile');

function createMockVisionClient() {
  return {
    mode: 'mock',
    assertConfigured() {},
    async extract(prepared, documentType, { signal, deadlineAt }) {
      requireCertificate(documentType);
      if (signal?.aborted) throw new DOMException('Extraction was cancelled.', 'AbortError');
      if (performance.now() >= deadlineAt) {
        throw new ApiError(504, 'processing_timeout', 'The processing deadline was exceeded.', { retryable: true });
      }
      // Fixed synthetic values for ANY image, even blank input. This is not OCR.
      return {
        readable: true, detectedDocumentType: 'student_certificate',
        fields: { fullName: 'Иван Петров Иванов', facultyNumber: '001234567', specialty: 'Компютърни системи и технологии', yearOfStudy: 2 },
        uncertainFields: [],
      };
    },
  };
}

module.exports = { createMockVisionClient };
