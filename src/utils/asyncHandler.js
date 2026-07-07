// localpulse/server/src/utils/asyncHandler.js

// Wraps an async route handler so thrown errors / rejected promises flow to the
// central error middleware instead of needing try/catch in every controller.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
