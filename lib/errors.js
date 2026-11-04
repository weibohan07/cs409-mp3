'use strict';

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  let status = 500;
  let message = 'The server could not complete this request. Please try again.';

  if (error instanceof ApiError) {
    status = error.status;
    message = error.message;
  } else if (error?.type === 'entity.parse.failed') {
    status = 400;
    message = 'The request body must contain valid JSON.';
  } else if (error?.type === 'entity.too.large') {
    status = 400;
    message = 'The request body is too large.';
  } else if (error?.code === 11000) {
    status = 400;
    message = 'This email address is already used by another user.';
  } else if (error?.name === 'ValidationError' || error?.name === 'CastError') {
    status = 400;
    message = 'One or more fields contain an invalid value.';
  } else if (error?.status === 400 || error?.statusCode === 400) {
    status = 400;
    message = 'The request is not valid.';
  }

  // Never send driver messages, connection strings, or stack traces to clients.
  res.status(status).json({ message, data: {} });
}

module.exports = { ApiError, errorHandler };
