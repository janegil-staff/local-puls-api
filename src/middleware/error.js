// localpulse/server/src/middleware/error.js
import { ApiError } from '../utils/ApiError.js';
import { config } from '../config/index.js';

// 404 for unmatched routes.
export function notFound(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// Central error handler. Must have 4 args for Express to treat it as such.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  // Mongoose duplicate key → 409.
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(409).json({ error: `That ${field} is already in use` });
  }
  // Mongoose validation → 400.
  if (err.name === 'ValidationError') {
    const details = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ error: 'Validation failed', details });
  }
  // Bad ObjectId → 400.
  if (err.name === 'CastError') {
    return res.status(400).json({ error: `Invalid ${err.path}` });
  }

  const status = err.status || 500;
  const message = err.expose ? err.message : status === 500 ? 'Something went wrong' : err.message;

  if (status >= 500) console.error('Unhandled error:', err);

  return res.status(status).json({
    error: message,
    ...(err.details ? { details: err.details } : {}),
    ...(config.isProd ? {} : { stack: status >= 500 ? err.stack : undefined }),
  });
}
