// localpulse/server/src/server.js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';

import { config } from './config/index.js';
import routes from './routes/index.js';

import { apiLimiter } from './middleware/rateLimit.js';
import { notFound, errorHandler } from './middleware/error.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.set('trust proxy', 1); // correct client IPs behind DO's proxy
app.use(helmet({ crossOriginResourcePolicy: false })); // allow images to load cross-origin
// server.js — replace the cors() line
const corsOrigins = config.clientOrigins.includes('*') ? true : config.clientOrigins;
app.use(cors({
  origin: corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  
})); app.use(express.json({ limit: '2mb' }));
app.use(morgan(config.isProd ? 'combined' : 'dev'));

// Serve locally-stored uploads (dev fallback when Spaces isn't configured).
app.use('/uploads', express.static(path.resolve(__dirname, '../uploads')));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'localpulse', env: config.env }));

app.use('/api', apiLimiter, routes);

// 404 + central error handler (must be last).
app.use(notFound);
app.use(errorHandler);

export {
  app,
  config,
};