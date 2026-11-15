function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  // Do not log request bodies, configuration objects, or arbitrary error messages.
  console.error('[server] An unhandled request error occurred.');
  return res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'An internal processing error occurred.',
      retryable: false,
      details: {},
    },
  });
}

module.exports = errorHandler;
