import { config, app} from "./app.js";
import { createServer } from 'http';
import { Server } from 'socket.io';
import { registerChat } from './socket/chat.js';
import mongoose from "mongoose";

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: config.clientOrigins.includes('*') ? '*' : config.clientOrigins, methods: ['GET', 'POST'] },
});

registerChat(io);
app.set('io', io);

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
