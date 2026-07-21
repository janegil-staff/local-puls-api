// localpulse/server/src/middleware/auth.js

import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { config } from '../config/index.js';

/**
 * Create a JWT for a logged-in user.
 *
 * The user ID is stored in the standard `sub` claim.
 */
export function signToken(userId) {
  if (!userId) {
    throw new Error('Cannot sign token without a user ID');
  }

  return jwt.sign(
    {
      sub: String(userId),
    },
    config.jwtSecret,
    {
      expiresIn: config.jwtExpiresIn,
    }
  );
}

/**
 * Express authentication middleware.
 *
 * Expected header:
 * Authorization: Bearer <token>
 */
export async function requireAuth(req, res, next) {
  try {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentication required',
      });
    }

    const token = authorization.slice('Bearer '.length).trim();

    if (!token) {
      return res.status(401).json({
        error: 'Authentication required',
      });
    }

    const payload = jwt.verify(token, config.jwtSecret);
    const userId = payload.sub || payload.id;

    if (!userId) {
      return res.status(401).json({
        error: 'Invalid token',
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(401).json({
        error: 'User not found',
      });
    }

    // Common properties used by controllers.
    req.user = user;
    req.userId = String(user._id);

    return next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        error: 'Token expired',
      });
    }

    if (err instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({
        error: 'Invalid token',
      });
    }

    console.error('[auth] authentication failed:', err);

    return res.status(500).json({
      error: 'Authentication failed',
    });
  }
}

/**
 * Optional authentication middleware.
 *
 * Requests continue when no token is supplied, but req.user and req.userId
 * are populated when a valid token is present.
 */
export async function optionalAuth(req, res, next) {
  try {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith('Bearer ')) {
      return next();
    }

    const token = authorization.slice('Bearer '.length).trim();

    if (!token) {
      return next();
    }

    const payload = jwt.verify(token, config.jwtSecret);
    const userId = payload.sub || payload.id;

    if (!userId) {
      return next();
    }

    const user = await User.findById(userId);

    if (user) {
      req.user = user;
      req.userId = String(user._id);
    }

    return next();
  } catch {
    // Optional authentication should not block the request.
    return next();
  }
}