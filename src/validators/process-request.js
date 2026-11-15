const { ENABLED_DOCUMENT_TYPES } = require('../config/document-types');
const { ApiError } = require('../errors/api-error');

const MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function hasExactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function invalidRequest(message, field) {
  return new ApiError(400, 'invalid_request', message, { details: { field } });
}

function validateProcessRequest(body, limits) {
  if (!hasExactKeys(body, ['documentId', 'documentType', 'file'])) {
    throw invalidRequest('Request must contain exactly documentId, documentType and file.', 'body');
  }
  if (typeof body.documentId !== 'string' || body.documentId.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(body.documentId)
    || body.documentId.trim() !== body.documentId) {
    throw invalidRequest('documentId must be a valid identifier of 1 to 128 characters.', 'documentId');
  }
  if (typeof body.documentType !== 'string') {
    throw invalidRequest('documentType must be a string.', 'documentType');
  }
  // Deliberately precedes inspecting file fields or decoding their contents.
  if (!ENABLED_DOCUMENT_TYPES.includes(body.documentType)) {
    throw new ApiError(422, 'unsupported_document_type', 'This document type cannot be processed.', {
      details: { field: 'documentType' },
    });
  }
  if (!hasExactKeys(body.file, ['mimeType', 'contentBase64'])) {
    throw invalidRequest('file must contain exactly mimeType and contentBase64.', 'file');
  }
  if (typeof body.file.mimeType !== 'string') {
    throw invalidRequest('file.mimeType must be a string.', 'file.mimeType');
  }
  if (!MIME_TYPES.has(body.file.mimeType)) {
    throw new ApiError(415, 'unsupported_file', 'Only PDF, JPG and PNG files are supported.', {
      details: { field: 'file.mimeType' },
    });
  }

  const encoded = body.file.contentBase64;
  if (typeof encoded !== 'string') {
    throw invalidRequest('file.contentBase64 must be a string.', 'file.contentBase64');
  }
  const maxEncodedLength = 4 * Math.ceil(limits.maxFileBytes / 3);
  if (encoded.length > maxEncodedLength) {
    throw new ApiError(413, 'file_too_large', 'Decoded file exceeds the configured byte limit.', {
      details: { maxBytes: limits.maxFileBytes },
    });
  }
  // A simple linear character check avoids a deeply repeated quartet regex on large files.
  if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new ApiError(400, 'invalid_base64', 'File content must be canonical padded Base64.', {
      details: { field: 'file.contentBase64' },
    });
  }

  const buffer = Buffer.from(encoded, 'base64');
  // Buffer.from is permissive. Round-trip equality also rejects nonzero padding bits.
  if (!buffer.length || buffer.toString('base64') !== encoded) {
    throw new ApiError(400, 'invalid_base64', 'File content must be canonical padded Base64.', {
      details: { field: 'file.contentBase64' },
    });
  }
  if (buffer.length > limits.maxFileBytes) {
    throw new ApiError(413, 'file_too_large', 'Decoded file exceeds the configured byte limit.', {
      details: { maxBytes: limits.maxFileBytes },
    });
  }

  return {
    documentId: body.documentId,
    documentType: body.documentType,
    mimeType: body.file.mimeType,
    buffer,
  };
}

module.exports = { validateProcessRequest };
