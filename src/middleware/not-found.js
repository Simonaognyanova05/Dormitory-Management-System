function notFound(req, res) {
  res.status(404).json({
    error: {
      code: 'not_found',
      message: 'The requested endpoint was not found.',
      retryable: false,
      details: {},
    },
  });
}

module.exports = notFound;
