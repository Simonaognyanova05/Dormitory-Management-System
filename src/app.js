const express = require('express');
const healthRoutes = require('./routes/health.routes');
const { createOcrRoutes } = require('./routes/ocr.routes');
const { loadConfig } = require('./config/env');
const { createDocumentProcessor } = require('./services/document-processing/process-document');
const notFound = require('./middleware/not-found');
const errorHandler = require('./middleware/error-handler');

function createApp({ config = loadConfig(), processDocument } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.use(healthRoutes);
  app.use(createOcrRoutes({ config, processDocument: processDocument ?? createDocumentProcessor(config) }));
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
