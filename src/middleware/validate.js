// localpulse/server/src/middleware/validate.js
import { ApiError } from '../utils/ApiError.js';

// A tiny schema validator so we don't pull in a heavy dep. Each field rule is
// { required, type, min, max, enum, isEmail }. Returns 400 with details on fail.
function checkValue(key, value, rule) {
  const errors = [];
  const present = value !== undefined && value !== null && value !== '';

  if (rule.required && !present) {
    errors.push(`${key} is required`);
    return errors; // no point checking further
  }
  if (!present) return errors; // optional + absent → ok

  if (rule.type === 'string' && typeof value !== 'string') errors.push(`${key} must be a string`);
  if (rule.type === 'number' && typeof value !== 'number') errors.push(`${key} must be a number`);

  if (typeof value === 'string') {
    if (rule.min && value.length < rule.min) errors.push(`${key} must be at least ${rule.min} characters`);
    if (rule.max && value.length > rule.max) errors.push(`${key} must be at most ${rule.max} characters`);
    if (rule.isEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push(`${key} must be a valid email`);
  }
  if (rule.enum && !rule.enum.includes(value)) {
    errors.push(`${key} must be one of: ${rule.enum.join(', ')}`);
  }
  return errors;
}

// Usage: validate({ body: { email: { required: true, isEmail: true } } })
export function validate(schema) {
  return (req, _res, next) => {
    const all = [];
    for (const source of ['body', 'query', 'params']) {
      if (!schema[source]) continue;
      for (const [key, rule] of Object.entries(schema[source])) {
        all.push(...checkValue(key, req[source]?.[key], rule));
      }
    }
    if (all.length) return next(ApiError.badRequest('Validation failed', all));
    next();
  };
}
