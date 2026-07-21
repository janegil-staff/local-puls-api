// localpulse/server/src/socket/chat.js
//
// Socket.IO chat handler. Event contract matches the mobile client
// (localpulse/app/src/api/socket.js + chatStore.js):
//
//   client emits:  chat:join {conversationId}, chat:leave {conversationId},
//                  chat:send {conversationId, text}, chat:sendImage {conversationId, imageUrl},
//                  chat:typing {conversationId}
//   server emits:  chat:message <Message.toClient()>, chat:notify {conversationId},
//                  chat:typing {userId}
//
// Wire from server.js AFTER creating io:
//   import { registerChatSocket } from './socket/chat.js';
//   app.set('io', io);
//   registerChatSocket(io);
//
import jwt from 'jsonwebtoken';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { config } from '../config/index.js';

export function registerChatSocket(io) {
  // Handshake auth — token comes from client `auth: (cb) => cb({ token })`.
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('No token'));
      const payload = jwt.verify(token, config.jwtSecret);
      socket.userId = String(payload.sub);
      return next();
    } catch {
      return next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.userId}`);
    if (process.env.NODE_ENV !== 'production') {
      console.log('[socket] connected', socket.id, 'user', socket.userId);
    }

    socket.on('chat:join', ({ conversationId }) => {
      if (conversationId) socket.join(`conversation:${conversationId}`);
    });

    socket.on('chat:leave', ({ conversationId }) => {
      if (conversationId) socket.leave(`conversation:${conversationId}`);
    });

    // Shared persistence + broadcast for both text and image messages.
    async function persistAndBroadcast({ conversationId, text, imageUrl }) {
      const convo = await Conversation.findById(conversationId);
      if (!convo) return { error: 'Conversation not found' };

      const participants = convo.participants.map((p) => String(p));
      if (!participants.includes(socket.userId)) {
        return { error: 'Not a participant' };
      }

      // Gating: a pending conversation only accepts messages from the
      // initiator (their opener sits in the recipient's Requests). The
      // recipient must accept (REST /accept) before they can reply.
      if (convo.status === 'pending' && String(convo.initiator) !== socket.userId) {
        return { error: 'Accept the request before replying' };
      }

      const message = await Message.create({
        conversation: convo._id,
        sender: socket.userId,
        ...(text ? { text: text.trim() } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        readBy: [socket.userId], // sender has implicitly read their own message
      });

      // Denormalized preview for the conversation list.
      convo.lastMessage = text ? text.trim() : '📷';
      convo.lastMessageAt = message.createdAt;
      await convo.save();

      // Populate sender so toClient()'s toPublic() path has a real user doc.
      await message.populate('sender');
      const payload = message.toClient();

      // Broadcast to the room (includes sender for optimistic-UI reconcile).
      io.to(`conversation:${convo._id}`).emit('chat:message', payload);

      // Bump unread for the other participant(s), even if not in the room.
      participants
        .filter((p) => p !== socket.userId)
        .forEach((p) => io.to(`user:${p}`).emit('chat:notify', {
          conversationId: String(convo._id),
        }));

      return { ok: true, message: payload };
    }

    // Text send — THE MISSING WRITE PATH. Mobile emits chat:send.
    socket.on('chat:send', async ({ conversationId, text }, ack) => {
      try {
        if (!conversationId || !text?.trim()) {
          return ack?.({ error: 'Missing fields' });
        }
        const result = await persistAndBroadcast({ conversationId, text });
        return ack?.(result);
      } catch (err) {
        console.error('[socket chat:send] failed:', err);
        return ack?.({ error: 'Server error' });
      }
    });

    // Image send — mobile emits after uploading, awaits ack for rejections.
    socket.on('chat:sendImage', async ({ conversationId, imageUrl }, ack) => {
      try {
        if (!conversationId || !imageUrl) {
          return ack?.({ error: 'Missing fields' });
        }
        const result = await persistAndBroadcast({ conversationId, imageUrl });
        return ack?.(result);
      } catch (err) {
        console.error('[socket chat:sendImage] failed:', err);
        return ack?.({ error: 'Server error' });
      }
    });

    // Typing relay — to the room, excluding the sender.
    socket.on('chat:typing', ({ conversationId }) => {
      if (!conversationId) return;
      socket.to(`conversation:${conversationId}`).emit('chat:typing', {
        userId: socket.userId,
      });
    });

    socket.on('disconnect', (reason) => {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[socket] disconnect', socket.id, reason);
      }
    });
  });
}