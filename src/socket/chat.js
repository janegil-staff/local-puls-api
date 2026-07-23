// localpulse/server/src/socket/chat.js
//
// Socket.IO chat handler.
//
// Persistence now lives in the REST controller (chatController.js). The client
// sends messages over REST; the controller persists and broadcasts chat:message
// to the conversation room. This socket handler is kept for:
//   - room membership (chat:join / chat:leave) so broadcasts reach open threads
//   - typing relay (chat:typing)
//   - live delivery of the events the controller emits
//
// The socket-based send handlers (chat:send / chat:sendImage) and their pending
// gate have been REMOVED. They were a second, divergent persistence path and
// the source of Android message loss (emit into a disconnected socket is
// silently dropped). If an old client still emits chat:send, it is ignored.
//
import jwt from 'jsonwebtoken';
import Conversation from '../models/Conversation.js';
import { config } from '../config/index.js';

export function registerChatSocket(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('No token'));

      const payload = jwt.verify(token, config.jwtSecret);
      const userId = payload.sub || payload.id;
      if (!userId) return next(new Error('Invalid token payload'));

      socket.userId = String(userId);
      return next();
    } catch (err) {
      console.error('[socket auth] failed:', err.message);
      return next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.userId}`);
    console.log('[socket] connected', socket.id, 'user', socket.userId);

    socket.on('chat:join', async ({ conversationId } = {}, ack) => {
      try {
        if (!conversationId) return ack?.({ error: 'Missing conversation ID' });

        const convo = await Conversation.findOne({
          _id: conversationId,
          participants: socket.userId,
        }).select('_id');
        if (!convo) return ack?.({ error: 'Conversation not found or access denied' });

        await socket.join(`conversation:${conversationId}`);
        console.log('[socket chat:join]', { userId: socket.userId, conversationId });
        return ack?.({ ok: true });
      } catch (err) {
        console.error('[socket chat:join] failed:', err);
        return ack?.({ error: 'Server error' });
      }
    });

    socket.on('chat:leave', ({ conversationId }) => {
      if (conversationId) socket.leave(`conversation:${conversationId}`);
    });

    // Typing relay — to the room, excluding the sender.
    socket.on('chat:typing', ({ conversationId }) => {
      if (!conversationId) return;
      socket.to(`conversation:${conversationId}`).emit('chat:typing', {
        userId: socket.userId,
      });
    });

    socket.on('disconnect', (reason) => {
      console.log('[socket] disconnect', socket.id, reason);
    });
  });
}