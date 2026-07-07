// localpulse/server/src/config/index.js
import dotenv from 'dotenv';
dotenv.config();

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    // In production, fail fast on missing critical config.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Missing required env var: ${name}`);
    }
    console.warn(`⚠️  Env var ${name} not set — using insecure dev default`);
  }
  return v;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT) || 4000,

  mongoUri: required('MONGO_URI', 'mongodb://127.0.0.1:27017/localpulse'),
  jwtSecret: required('JWT_SECRET', 'dev-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',

  clientOrigins: (process.env.CLIENT_ORIGINS || '*').split(',').map((s) => s.trim()),

  spaces: {
    key: process.env.SPACES_KEY || '',
    secret: process.env.SPACES_SECRET || '',
    region: process.env.SPACES_REGION || 'fra1',
    bucket: process.env.SPACES_BUCKET || 'localpulse',
    endpoint: process.env.SPACES_ENDPOINT || `https://${process.env.SPACES_REGION || 'fra1'}.digitaloceanspaces.com`,
  },

  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX) || 300,
    authMax: Number(process.env.RATE_LIMIT_AUTH_MAX) || 20,
  },
};
