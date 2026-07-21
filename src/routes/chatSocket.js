// localpulse/server/src/socket/chatSocket.js
//
// Wire this from server.js after you create the io instance:
//
//   import { registerChatSocket } from './socket/chatSocket.js';
//   const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGINS, credentials: true } });
//   app.set('io', io);                 // so REST controllers can emit
//   registerChatSocket(io);
//
import jwt from 'jsonwebtoken';
import Conversation from '../models/Conversation.js'; // TODO: confirm path
import Message from '../models/Message.js';           // TODO: confirm path

export function registerChatSocket(io) {
  // Auth middleware — reads token from handshake.auth (matches the client
  // `auth: (cb) => cb({ token: getToken() })` pattern used to fix null tokens).
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('No token'));
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = payload.id || payload.sub; // TODO: confirm claim name
      return next();
    } catch (err) {
      return next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    // Personal room for direct notifications.
    socket.join(`user:${socket.userId}`);

    // Join a conversation room (client emits this when opening a thread).
    socket.on('conversation:join', (conversationId) => {
      if (conversationId) socket.join(`conversation:${conversationId}`);
    });

    socket.on('conversation:leave', (conversationId) => {
      if (conversationId) socket.leave(`conversation:${conversationId}`);
    });

    // OPTIONAL socket-side send. REST is the source of truth for persistence,
    // but this lets low-latency clients send over the socket too. It writes
    // then broadcasts, mirroring the REST controller.
    socket.on('message:send', async ({ conversationId, text }, ack) => {
      try {
        if (!conversationId || !text?.trim()) {
          return ack?.({ ok: false, error: 'Missing fields' });
        }
        const convo = await Conversation.findById(conversationId);
        if (!convo) return ack?.({ ok: false, error: 'Not found' });

        const participants = (convo.participants || []).map((p) => String(p));
        if (!participants.includes(String(socket.userId))) {
          return ack?.({ ok: false, error: 'Not a participant' });
        }

        const message = await Message.create({
          conversation: convo._id,
          sender: socket.userId,
          text: text.trim(),
        });

        convo.lastMessage = message._id;
        convo.lastMessageAt = message.createdAt;
        await convo.save();

        io.to(`conversation:${convo._id}`).emit('message:new', {
          conversationId: String(convo._id),
          message: message.toJSON ? message.toJSON() : message,
        });

        return ack?.({ ok: true, message });
      } catch (err) {
        console.error('[socket message:send] failed:', err);
        return ack?.({ ok: false, error: 'Server error' });
      }
    });
  });
}
