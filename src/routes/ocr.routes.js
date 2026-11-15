const express = require('express');
const { MIMEType } = require('node:util');
const { isUtf8 } = require('node:buffer');
const { ApiError } = require('../errors/api-error');
const { serviceAuth } = require('../middleware/service-auth');
const { validateProcessRequest } = require('../validators/process-request');
const { inspectDocumentFile } = require('../validators/document-file');

function createOcrRoutes({ config, processDocument }) {
  const router = express.Router();

  router.post(
    '/api/v1/ocr/process',
    serviceAuth(config.serviceToken),
    (req, res, next) => {
      let contentType;
      try {
        contentType = new MIMEType(req.headers['content-type']);
      } catch {
        return next(new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json.'));
      }
      if (contentType.essence !== 'application/json') {
        return next(new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json.'));
      }
      const charset = contentType.params.get('charset');
      if (charset && charset.toLowerCase() !== 'utf-8') {
        return next(new ApiError(415, 'unsupported_media_type', 'Use uncompressed UTF-8 JSON.'));
      }
      return next();
    },
    express.json({
      limit: config.limits.maxJsonBodyBytes,
      strict: false,
      inflate: false,
      verify: (req, res, buffer) => {
        if (!isUtf8(buffer)) throw new ApiError(400, 'invalid_json', 'Request body is not valid UTF-8 JSON.');
      },
    }),
    async (req, res) => {
      const input = validateProcessRequest(req.body, config.limits);
      req.body = undefined;
      const metadata = await inspectDocumentFile(input, config.limits);
      const result = await processDocument({ ...input, metadata });
      res.status(200).json(result);
    },
  );

  return router;
}

module.exports = { createOcrRoutes };
