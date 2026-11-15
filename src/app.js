const express = require('express');
const healthRoutes = require('./routes/health.routes');
const notFound = require('./middleware/not-found');
const errorHandler = require('./middleware/error-handler');

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use(healthRoutes);
  // Authenticated JSON parsing and the OCR route are introduced in task 5.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
