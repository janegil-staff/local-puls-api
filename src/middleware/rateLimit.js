// localpulse/server/src/middleware/rateLimit.js
import { config } from '../config/index.js';

// Minimal fixed-window rate limiter keyed by IP. In-memory is fine for a single
// instance / portfolio deploy; swap for a Redis store if you scale horizontally.
function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }

  // Periodically clear expired buckets so the map doesn't grow unbounded.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits.entries()) if (v.resetAt <= now) hits.delete(k);
  }, windowMs).unref?.();

  return function limiter(req, res, next) {
    const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    let bucket = hits.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(key, bucket);
    }
    bucket.count += 1;

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - bucket.count));

    if (bucket.count > max) {
      const retry = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', retry);
      return res.status(429).json({ error: 'Too many requests, slow down' });
    }
    next();
  };
}

export const apiLimiter = createLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max });
export const authLimiter = createLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.authMax });
