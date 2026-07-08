// localpulse/server/src/socket/chat.js
import jwt from 'jsonwebtoken';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Block from '../models/Block.js';
import { config } from '../config/index.js';

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

// Is there a block in either direction between two users?
async function blockedBetween(a, b) {
  const block = await Block.findOne({
    $or: [
      { blocker: a, blocked: b },
      { blocker: b, blocked: a },
    ],
  });
  return Boolean(block);
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

        // Open messaging: anyone can message anyone UNLESS a block exists.
        // (Pending conversations are allowed — the initiator's messages land in
        // the recipient's Requests until they accept.)
        const other = convo.participants.find((p) => String(p) !== String(socket.userId));
        if (other && (await blockedBetween(socket.userId, other))) {
          return ack?.({ error: 'You cannot message this user' });
        }

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
        // Include the conversation status so the client can route the ping to
        // Messages vs Requests.
        convo.participants
          .filter((p) => String(p) !== String(socket.userId))
          .forEach((p) =>
            io.to(`user:${p}`).emit('chat:notify', {
              conversationId,
              preview: t,
              status: convo.status,
              pending: convo.status === 'pending',
            })
          );

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