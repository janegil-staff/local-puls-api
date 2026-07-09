// localpulse/server/src/socket/chat.js
import jwt from 'jsonwebtoken';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Block from '../models/Block.js';
import User from '../models/User.js';
import { config } from '../config/index.js';

// The uploader returns absolute URLs; refuse anything else so a client can't
// make us persist a link to an arbitrary host and render it in every bubble.
const ALLOWED_IMAGE_PREFIXES = [
  `${config.publicUrl ?? ''}/uploads/`,
  config.spacesCdnUrl ?? null,
].filter(Boolean);

// Cloudinary's delivery host is fixed. Deriving the prefix from
// config.cloudinary.cloudName means an unset env var silently rejects every
// image — which is what happened in production, because the /upload route
// configures the SDK from its own env vars and never touches config.cloudinary.
// Match the host and let the cloud name be whatever it is.
const CLOUDINARY_HOST = 'res.cloudinary.com';

function isAllowedImageUrl(url) {
  if (typeof url !== 'string' || url.length > 500) return false;

  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  if (parsed.hostname === CLOUDINARY_HOST) return true;

  // Dev fallback for local /uploads/ when Cloudinary isn't configured.
  if (config.publicUrl && url.startsWith(`${config.publicUrl.replace(/\/$/, '')}/uploads/`)) return true;

  return false;
}

// Mark a user active now (throttled by the 2-min "online" window on read).
async function touchLastSeen(userId) {
  try { await User.updateOne({ _id: userId }, { lastSeenAt: new Date() }); } catch { /* ignore */ }
}

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

// Shared by chat:send and chat:sendImage. Loads the conversation, runs the
// participant and block checks, and returns { convo, other } or an error
// string — never both.
async function loadSendable(userId, conversationId) {
  if (!conversationId) return { error: 'Empty message' };

  const convo = await Conversation.findById(conversationId);
  if (!convo || !convo.participants.some((p) => String(p) === String(userId))) {
    return { error: 'Not a participant' };
  }

  // Open messaging: anyone can message anyone UNLESS a block exists.
  // (Pending conversations are allowed for text — the initiator's messages
  // land in the recipient's Requests until they accept.)
  const other = convo.participants.find((p) => String(p) !== String(userId));
  if (other && (await blockedBetween(userId, other))) {
    return { error: 'You cannot message this user' };
  }

  return { convo, other };
}

// Persist, bump the conversation, broadcast to the room, notify the rest.
// `preview` is what the conversation list shows; for images it's a marker the
// client localizes rather than a translated string chosen on the server.
async function deliver(io, userId, convo, fields, preview) {
  const message = await Message.create({
    conversation: convo._id,
    sender: userId,
    readBy: [userId],
    ...fields,
  });
  await message.populate('sender');

  convo.lastMessage = preview;
  convo.lastMessageAt = new Date();
  await convo.save();

  const payload = message.toClient();
  io.to(`convo:${convo._id}`).emit('chat:message', payload);

  // Notify participants not currently in the room (badge/notification).
  // Include the conversation status so the client can route the ping to
  // Messages vs Requests.
  convo.participants
    .filter((p) => String(p) !== String(userId))
    .forEach((p) =>
      io.to(`user:${p}`).emit('chat:notify', {
        conversationId: convo._id,
        preview,
        status: convo.status,
        pending: convo.status === 'pending',
      })
    );

  return payload;
}

export function registerChat(io) {
  io.use(authSocket);

  io.on('connection', (socket) => {
    // Personal room so we can push notifications to a user across devices.
    socket.join(`user:${socket.userId}`);

    // Mark active on connect, and on a periodic heartbeat from the client.
    touchLastSeen(socket.userId);
    socket.on('presence:ping', () => touchLastSeen(socket.userId));

    // Join a conversation room to receive its messages live.
    socket.on('chat:join', ({ conversationId }) => {
      if (conversationId) socket.join(`convo:${conversationId}`);
    });

    socket.on('chat:leave', ({ conversationId }) => {
      if (conversationId) socket.leave(`convo:${conversationId}`);
    });

    // Send a text message.
    socket.on('chat:send', async ({ conversationId, text }, ack) => {
      try {
        const t = String(text || '').trim();
        if (!t) return ack?.({ error: 'Empty message' });

        const { convo, error } = await loadSendable(socket.userId, conversationId);
        if (error) return ack?.({ error });

        const payload = await deliver(io, socket.userId, convo, { text: t }, t);
        ack?.({ ok: true, message: payload });
      } catch (err) {
        console.error('chat:send error', err);
        ack?.({ error: 'Send failed' });
      }
    });

    // Send an image. Unlike text, this requires an ACCEPTED conversation:
    // a pending request is an unsolicited channel, and an unsolicited image
    // in a location-based app is a well-known abuse vector. The recipient
    // opts in by accepting first.
    socket.on('chat:sendImage', async ({ conversationId, imageUrl }, ack) => {
      try {
        if (!isAllowedImageUrl(imageUrl)) return ack?.({ error: 'Invalid image' });

        const { convo, error } = await loadSendable(socket.userId, conversationId);
        if (error) return ack?.({ error });

        if (convo.status !== 'accepted') {
          return ack?.({ error: 'You can send photos once they accept your request' });
        }

        // '📷' rather than a sentence: the client localizes the preview.
        const payload = await deliver(io, socket.userId, convo, { imageUrl }, '📷');
        ack?.({ ok: true, message: payload });
      } catch (err) {
        console.error('chat:sendImage error', err);
        ack?.({ error: 'Send failed' });
      }
    });

    // Typing indicator.
    socket.on('chat:typing', ({ conversationId }) => {
      socket.to(`convo:${conversationId}`).emit('chat:typing', { userId: socket.userId });
    });
  });
}