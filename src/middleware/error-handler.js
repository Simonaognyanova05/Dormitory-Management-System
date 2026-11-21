const { ApiError } = require('../errors/api-error');

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  let exposed = error instanceof ApiError ? error : null;
  if (!exposed && error.type === 'entity.too.large') {
    exposed = new ApiError(413, 'payload_too_large', 'JSON body exceeds the configured byte limit.');
  } else if (!exposed && error.type === 'entity.parse.failed') {
    exposed = new ApiError(400, 'invalid_json', 'Request body is not valid JSON.');
  } else if (!exposed && ['encoding.unsupported', 'charset.unsupported'].includes(error.type)) {
    exposed = new ApiError(415, 'unsupported_media_type', 'Use uncompressed UTF-8 JSON.');
  } else if (!exposed && ['request.aborted', 'request.size.invalid'].includes(error.type)) {
    exposed = new ApiError(400, 'invalid_request', 'Request body could not be read.');
  }
  if (exposed) {
    const seconds = exposed.details?.retryAfterSeconds;
    if (exposed.retryable && Number.isSafeInteger(seconds) && seconds >= 0) res.set('Retry-After', String(seconds));
    return res.status(exposed.status).json({
      error: {
        code: exposed.code,
        message: exposed.message,
        retryable: exposed.retryable,
        details: exposed.details,
      },
    });
  }

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
