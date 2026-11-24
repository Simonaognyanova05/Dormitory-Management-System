const { performance } = require('node:perf_hooks');
const { ApiError } = require('../../errors/api-error');
const { getDocumentProfile } = require('./document-profiles');

function createMockVisionClient() {
  return {
    mode: 'mock',
    assertConfigured() {},
    async extract(prepared, documentType, { signal, deadlineAt }) {
      getDocumentProfile(documentType);
      if (signal?.aborted) throw new DOMException('Extraction was cancelled.', 'AbortError');
      if (performance.now() >= deadlineAt) {
        throw new ApiError(504, 'processing_timeout', 'The processing deadline was exceeded.', { retryable: true });
      }
      // Fixed synthetic values for ANY image, even blank input. This is not OCR.
      return {
        readable: true, detectedDocumentType: documentType,
        fields: documentType === 'student_certificate'
          ? { fullName: 'Иван Петров Иванов', facultyNumber: '001234567', specialty: 'Компютърни системи и технологии', yearOfStudy: 2 }
          : { orderNumber: 'РД-001', orderDate: '2026-11-03', dormitory: '01', room: '012А' },
        uncertainFields: [],
      };
    },
  };
}

module.exports = { createMockVisionClient };
