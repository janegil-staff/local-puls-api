// localpulse/server/src/server.js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { config } from './config/index.js';
import routes from './routes/index.js';
import { registerChat } from './socket/chat.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { notFound, errorHandler } from './middleware/error.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.set('trust proxy', 1); // correct client IPs behind DO's proxy
app.use(helmet({ crossOriginResourcePolicy: false })); // allow images to load cross-origin
app.use(cors({ origin: config.clientOrigins.includes('*') ? true : config.clientOrigins }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan(config.isProd ? 'combined' : 'dev'));

// Serve locally-stored uploads (dev fallback when Spaces isn't configured).
app.use('/uploads', express.static(path.resolve(__dirname, '../uploads')));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'localpulse', env: config.env }));

app.use('/api', apiLimiter, routes);

// 404 + central error handler (must be last).
app.use(notFound);
app.use(errorHandler);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: config.clientOrigins.includes('*') ? '*' : config.clientOrigins, methods: ['GET', 'POST'] },
});
registerChat(io);

async function start() {
  try {
    await mongoose.connect(config.mongoUri);
    console.log('✅ Mongo connected');
    httpServer.listen(config.port, () =>
      console.log(`🌐 LocalPulse API + chat on :${config.port} [${config.env}]`)
    );
  } catch (err) {
    console.error('❌ Failed to start', err);
    process.exit(1);
  }
}

// Fail loudly on unhandled rejections rather than dying silently.
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

start();
