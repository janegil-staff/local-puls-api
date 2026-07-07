// localpulse/server/src/socket/chat.js
import jwt from 'jsonwebtoken';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { config } from '../config/index.js';
import { canAccessConversation } from '../lib/matchGuard.js';

// Authenticate the socket from the JWT passed in handshake auth.
function authSocket(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No token'));
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    socket.userId = payload.sub;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
}

export function registerChat(io) {
  io.use(authSocket);

  io.on('connection', (socket) => {
    // Personal room so we can push notifications to a user across devices.
    socket.join(`user:${socket.userId}`);

    // Join a conversation room to receive its messages live.
    socket.on('chat:join', ({ conversationId }) => {
      if (conversationId) socket.join(`convo:${conversationId}`);
    });

    socket.on('chat:leave', ({ conversationId }) => {
      if (conversationId) socket.leave(`convo:${conversationId}`);
    });

    // Send a message: persist, bump conversation, broadcast to the room + recipients.
    socket.on('chat:send', async ({ conversationId, text }, ack) => {
      try {
        const t = String(text || '').trim();
        if (!conversationId || !t) return ack?.({ error: 'Empty message' });

        const convo = await Conversation.findById(conversationId);
        if (!convo || !convo.participants.some((p) => String(p) === String(socket.userId))) {
          return ack?.({ error: 'Not a participant' });
        }

        // Chat is gated behind an active match — revoked on unmatch.
        const allowed = await canAccessConversation(socket.userId, conversationId);
        if (!allowed) return ack?.({ error: 'You are no longer matched' });

        const message = await Message.create({
          conversation: conversationId,
          sender: socket.userId,
          text: t,
          readBy: [socket.userId],
        });
        await message.populate('sender');

        convo.lastMessage = t;
        convo.lastMessageAt = new Date();
        await convo.save();

        const payload = message.toClient();
        io.to(`convo:${conversationId}`).emit('chat:message', payload);

        // Notify participants not currently in the room (badge/notification).
        convo.participants
          .filter((p) => String(p) !== String(socket.userId))
          .forEach((p) => io.to(`user:${p}`).emit('chat:notify', { conversationId, preview: t }));

        ack?.({ ok: true, message: payload });
      } catch (err) {
        console.error('chat:send error', err);
        ack?.({ error: 'Send failed' });
      }
    });

    // Typing indicator.
    socket.on('chat:typing', ({ conversationId }) => {
      socket.to(`convo:${conversationId}`).emit('chat:typing', { userId: socket.userId });
    });
  });
}
