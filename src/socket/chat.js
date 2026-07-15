// localpulse/server/src/socket/chat.js
import jwt from 'jsonwebtoken';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import User from '../models/User.js';
import { config } from '../config/index.js';
import { blockedBetween, canSeeConversation } from '../lib/blocks.js';

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
  //
  // A block between sender and recipient is impossible here — loadSendable
  // rejected it before we were called — so no further filtering is needed.
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
    //
    // GUARDED. This previously joined any room by ID with no checks at all: a
    // socket could subscribe to two strangers' conversation by guessing an
    // ObjectId, and a blocked user stayed subscribed to the thread they were
    // blocked from — still receiving every message and typing event, since
    // only the SEND path checked blocks, never the LISTEN path.
    //
    // The ack is new. A client that ignores it degrades to a chat that never
    // updates rather than one that leaks.
    socket.on('chat:join', async ({ conversationId }, ack) => {
      if (!conversationId) return ack?.({ error: 'No conversation' });
      try {
        const convo = await Conversation.findById(conversationId);
        if (!(await canSeeConversation(socket.userId, convo))) {
          // Same error whether it doesn't exist, isn't theirs, or is blocked.
          // Don't confirm the thread exists to someone who can't see it.
          return ack?.({ error: 'Conversation not found' });
        }
        socket.join(`convo:${conversationId}`);
        ack?.({ ok: true });
      } catch (err) {
        console.error('chat:join error', err);
        ack?.({ error: 'Could not join' });
      }
    });

    socket.on('chat:leave', ({ conversationId }) => {
      if (conversationId) socket.leave(`convo:${conversationId}`);
    });

    // localpulse/server/src/socket/chat.js

    socket.on('chat:send', async ({ conversationId, text }, cb) => {
      try {
        const body = String(text || '').trim();
        if (!body) return cb?.({ error: 'EMPTY' });
        if (body.length > 2000) return cb?.({ error: 'TOO_LONG' });

        const convo = await Conversation.findById(conversationId);
        if (!convo) return cb?.({ error: 'NOT_FOUND' });
        if (!convo.participants.some((p) => String(p) === String(userId))) {
          return cb?.({ error: 'FORBIDDEN' });
        }

        const otherId = convo.participants.find((p) => String(p) !== String(userId));
        if (await isBlockedBetween(userId, otherId)) {
          return cb?.({ error: 'BLOCKED' });
        }

        // A pending thread the viewer started allows exactly one message — the
        // opener, so the recipient has something to judge the request on. Every
        // message after that waits for accept. The recipient is unrestricted:
        // replying to a request is implicit consent, and accept() flips status
        // anyway. Images stay accepted-only regardless (see chat:sendImage).
        if (convo.status === 'pending' && String(convo.initiator) === String(userId)) {
          const sent = await Message.countDocuments({ conversation: convo._id });
          if (sent >= 1) return cb?.({ error: 'PENDING_LIMIT' });
        }

        const msg = await Message.create({
          conversation: convo._id,
          sender: userId,
          text: body,
        });

        convo.lastMessage = body;
        convo.lastMessageAt = msg.createdAt;
        await convo.save();

        await deliver(io, convo, msg, userId, otherId);
        return cb?.({ ok: true, message: serializeMessage(msg) });
      } catch (e) {
        console.error('chat:send', e);
        return cb?.({ error: 'SERVER' });
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

    // Typing indicator. Guarded like send: an unguarded emit lets anyone
    // broadcast into any room by ID, and lets someone you blocked watch you
    // type. Reuses loadSendable rather than a bare block check, so a
    // non-participant is rejected too.
    socket.on('chat:typing', async ({ conversationId }) => {
      if (!conversationId) return;
      try {
        const { error } = await loadSendable(socket.userId, conversationId);
        if (error) return;
        socket.to(`convo:${conversationId}`).emit('chat:typing', { userId: socket.userId });
      } catch (err) {
        console.error('chat:typing error', err);
      }
    });
  });
}

