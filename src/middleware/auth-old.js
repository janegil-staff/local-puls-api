// localpulse/server/src/middleware/auth.js
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import User from '../models/User.js';

export function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

// Hard auth — rejects if no valid token, OR if the account is banned.
//
// The ban check costs one findById per authed request. That's the price of a
// ban taking effect immediately: without it, a banned user's already-issued
// token stays valid until it expires (30 days), so the ban does nothing to a
// live session. The lookup is a single indexed _id read; fine at this scale.
// A banned user gets 403 'Account suspended', which the client treats as a
// forced logout (see client.js request()).
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await User.findById(payload.sub).select('banned');
    if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
    if (user.banned) return res.status(403).json({ error: 'Account suspended' });
    req.userId = user._id;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Soft auth — attaches userId if present, but doesn't block. Does NOT check
// banned: callers using optionalAuth (public feed, public profile) already gate
// any write behind requireAuth, and a banned user reading public content is
// harmless. Keeping this lookup-free preserves the fast path for anonymous and
// logged-out reads.
export function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.userId = jwt.verify(token, config.jwtSecret).sub; } catch { /* ignore */ }
  }
  next();
}