class ApiError extends Error {
  constructor(status, code, message, { retryable = false, details = {} } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

module.exports = { ApiError };
