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
import jwt from 'jsonwebtoken';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
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

    // Shared persistence + broadcast for both text and image messages.
    async function persistAndBroadcast({ conversationId, text, imageUrl }) {
      const convo = await Conversation.findById(conversationId);
      if (!convo) return { error: 'Conversation not found' };

      const participants = convo.participants.map((p) => String(p));
      if (!participants.includes(socket.userId)) {
        return { error: 'Not a participant' };
      }

      // ── TEMP DIAGNOSTIC ─────────────────────────────────────────────
      // Remove once the PENDING_LIMIT-on-first-message bug is understood.
      // Prints which branch of the pending gate fires and the message count.
      console.log('[pending gate] entry', {
        conversationId: String(convo._id),
        status: convo.status,
        initiator: String(convo.initiator),
        me: socket.userId,
        isInitiator: String(convo.initiator) === socket.userId,
      });
      // ────────────────────────────────────────────────────────────────

      // Pending gate:
      //  - The recipient cannot send until they accept.
      //  - The initiator gets exactly ONE opener; further messages are blocked
      //    until acceptance. Stops pre-acceptance spam.
      if (convo.status === 'pending') {
        if (String(convo.initiator) !== socket.userId) {
          return { error: 'Accept the request before replying', code: 'PENDING_RECIPIENT' };
        }
        const alreadySent = await Message.countDocuments({
          conversation: convo._id,
          sender: socket.userId,
        });

        // ── TEMP DIAGNOSTIC ──────────────────────────────────────────
        console.log('[pending gate] initiator branch, alreadySent =', alreadySent);
        // ─────────────────────────────────────────────────────────────

        if (alreadySent >= 1) {
          return { error: 'Wait for your request to be accepted before sending more.', code: 'PENDING_LIMIT' };
        }
      }

      const message = await Message.create({
        conversation: convo._id,
        sender: socket.userId,
        ...(text ? { text: text.trim() } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        readBy: [socket.userId],
      });

      convo.lastMessage = text ? text.trim() : '📷';
      convo.lastMessageAt = message.createdAt;
      await convo.save();

      await message.populate('sender');
      const payload = message.toClient();

      io.to(`conversation:${convo._id}`).emit('chat:message', payload);

      participants
        .filter((p) => p !== socket.userId)
        .forEach((p) => io.to(`user:${p}`).emit('chat:notify', {
          conversationId: String(convo._id),
        }));

      return { ok: true, message: payload };
    }

    // TEXT SEND — mobile + web emit chat:send.
    socket.on('chat:send', async ({ conversationId, text } = {}, ack) => {
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

    // IMAGE SEND — mobile emits after uploading, awaits ack for rejections.
    socket.on('chat:sendImage', async ({ conversationId, imageUrl } = {}, ack) => {
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
      console.log('[socket] disconnect', socket.id, reason);
    });
  });
}