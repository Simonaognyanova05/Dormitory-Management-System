const { createHash, timingSafeEqual } = require('node:crypto');
const { ApiError } = require('../errors/api-error');

function serviceAuth(serviceToken) {
  const expected = createHash('sha256').update(serviceToken).digest();

  return (req, res, next) => {
    if (!serviceToken) {
      return next(new ApiError(503, 'service_not_configured', 'SERVICE_TOKEN is not configured.'));
    }

    const supplied = req.headers['x-service-token'];
    if (typeof supplied !== 'string') {
      return next(new ApiError(401, 'unauthorized', 'A valid service token is required.'));
    }
    const actual = createHash('sha256').update(supplied).digest();
    if (!timingSafeEqual(actual, expected)) {
      return next(new ApiError(401, 'unauthorized', 'A valid service token is required.'));
    }
    return next();
  };
}

module.exports = { serviceAuth };
