// localpulse/server/src/controllers/chatController.js
//
// Chat controllers — SINGLE SOURCE OF TRUTH for persistence. Both web and
// mobile send via REST (POST /chat/conversations/:id/messages -> sendMessage).
// The controller saves the message, then emits it over the socket so the other
// participant gets it live. The socket handler no longer needs to persist.
//
// Conversation: { participants[], status: 'pending'|'accepted', initiator,
//                 lastMessage: String, lastMessageAt }
// Message:      { conversation, sender, text?, imageUrl?, readBy[] } + toClient()
//
import mongoose from 'mongoose';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';

function currentUserId(req) {
  return String(req.user.id || req.user.sub);
}

// Shared: persist a message + broadcast. Used by REST sendMessage.
// Returns { ok, message } or { status, error } for the caller to respond with.
async function persistMessage({ req, conversationId, senderId, text, imageUrl }) {
  const convo = await Conversation.findById(conversationId);
  if (!convo) return { status: 404, error: 'Conversation not found' };

  const participants = convo.participants.map((p) => String(p));
  if (!participants.includes(senderId)) {
    return { status: 403, error: 'Not a participant' };
  }

  // Pending gate: only the initiator may send into a pending conversation
  // (their one opener). The recipient must accept before replying.
  if (convo.status === 'pending' && String(convo.initiator) !== senderId) {
    return { status: 403, error: 'Accept the request before replying' };
  }

  const message = await Message.create({
    conversation: convo._id,
    sender: senderId,
    ...(text ? { text: text.trim() } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    readBy: [senderId],
  });

  convo.lastMessage = text ? text.trim() : '📷';
  convo.lastMessageAt = message.createdAt;
  await convo.save();

  await message.populate('sender');
  const payload = message.toClient();

  // Broadcast live to anyone in the conversation room + notify the other side.
  const io = req.app.get('io');
  if (io) {
    io.to(`conversation:${convo._id}`).emit('chat:message', payload);
    participants
      .filter((p) => p !== senderId)
      .forEach((p) => io.to(`user:${p}`).emit('chat:notify', {
        conversationId: String(convo._id),
      }));
  }

  return { ok: true, message: payload };
}

// ── Send a message (REST) — THE persistence path for web + mobile ─────
export async function sendMessage(req, res) {
  try {
    const me = currentUserId(req);
    const { id } = req.params;
    const { text, imageUrl } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid conversation id' });
    }
    if (!text?.trim() && !imageUrl) {
      return res.status(400).json({ error: 'Message is empty' });
    }

    const result = await persistMessage({
      req, conversationId: id, senderId: me, text, imageUrl,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });

    return res.status(201).json({ message: result.message });
  } catch (err) {
    console.error('[sendMessage] failed:', err);
    return res.status(500).json({ error: 'Failed to send message' });
  }
}

// ── List accepted conversations ───────────────────────────────────────
export async function listConversations(req, res) {
  try {
    const me = currentUserId(req);
    const convos = await Conversation.find({ participants: me, status: 'accepted' })
      .sort({ lastMessageAt: -1 })
      .populate('participants')
      .lean();

    const rows = convos.map((c) => {
      const other = (c.participants || []).find((p) => String(p._id) !== me);
      return {
        id: String(c._id),
        status: c.status,
        lastMessage: c.lastMessage,
        lastMessageAt: c.lastMessageAt,
        user: other
          ? { id: String(other._id), username: other.username, avatarUrl: other.avatarUrl }
          : null,
      };
    });
    return res.json({ conversations: rows });
  } catch (err) {
    console.error('[listConversations] failed:', err);
    return res.status(500).json({ error: 'Failed to load conversations' });
  }
}

// ── List pending requests awaiting this user's approval ───────────────
export async function listRequests(req, res) {
  try {
    const me = currentUserId(req);
    const convos = await Conversation.find({
      participants: me, status: 'pending', initiator: { $ne: me },
    })
      .sort({ lastMessageAt: -1 })
      .populate('participants')
      .lean();

    const rows = convos.map((c) => {
      const other = (c.participants || []).find((p) => String(p._id) !== me);
      return {
        id: String(c._id),
        lastMessage: c.lastMessage,
        lastMessageAt: c.lastMessageAt,
        user: other
          ? { id: String(other._id), username: other.username, avatarUrl: other.avatarUrl }
          : null,
      };
    });
    return res.json({ requests: rows });
  } catch (err) {
    console.error('[listRequests] failed:', err);
    return res.status(500).json({ error: 'Failed to load requests' });
  }
}

// ── Open (or re-open) a conversation with a user ──────────────────────
export async function openConversation(req, res) {
  try {
    const me = currentUserId(req);
    const { userId } = req.params;

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    if (String(userId) === me) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }

    let convo = await Conversation.findOne({
      participants: { $all: [me, userId], $size: 2 },
    });
    if (!convo) {
      convo = await Conversation.create({
        participants: [me, userId],
        initiator: me,
        status: 'pending',
      });
    }
    return res.json({ conversationId: String(convo._id), status: convo.status });
  } catch (err) {
    console.error('[openConversation] failed:', err);
    return res.status(500).json({ error: 'Failed to open conversation' });
  }
}

// ── Accept a pending request (recipient only) ─────────────────────────
export async function acceptConversation(req, res) {
  try {
    const me = currentUserId(req);
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid conversation id' });
    }

    const convo = await Conversation.findById(id);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });

    const participants = convo.participants.map((p) => String(p));
    if (!participants.includes(me)) {
      return res.status(403).json({ error: 'Not a participant' });
    }
    if (String(convo.initiator) === me) {
      return res.status(400).json({ error: 'Cannot accept your own request' });
    }

    if (convo.status !== 'accepted') {
      convo.status = 'accepted';
      await convo.save();
    }

    const io = req.app.get('io');
    if (io) {
      participants.forEach((p) =>
        io.to(`user:${p}`).emit('chat:accepted', { conversationId: String(convo._id) })
      );
    }
    return res.json({ ok: true, status: convo.status, conversationId: String(convo._id) });
  } catch (err) {
    console.error('[acceptConversation] failed:', err);
    return res.status(500).json({ error: 'Failed to accept conversation' });
  }
}

// ── Message history ───────────────────────────────────────────────────
export async function getMessages(req, res) {
  try {
    const me = currentUserId(req);
    const { id } = req.params;
    const { before, limit = 50 } = req.query;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid conversation id' });
    }

    const convo = await Conversation.findById(id);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    if (!convo.participants.map((p) => String(p)).includes(me)) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    const query = { conversation: id };
    if (before) query.createdAt = { $lt: new Date(before) };

    const docs = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 100))
      .populate('sender');

    const messages = docs.reverse().map((m) => m.toClient());
    return res.json({ messages });
  } catch (err) {
    console.error('[getMessages] failed:', err);
    return res.status(500).json({ error: 'Failed to load messages' });
  }
}

// ── Unread count across accepted conversations ────────────────────────
export async function chatUnreadCount(req, res) {
  try {
    const me = currentUserId(req);
    const convos = await Conversation.find({
      participants: me, status: 'accepted',
    }).select('_id');
    const ids = convos.map((c) => c._id);

    const count = await Message.countDocuments({
      conversation: { $in: ids },
      sender: { $ne: me },
      readBy: { $ne: me },
    });
    return res.json({ count });
  } catch (err) {
    console.error('[chatUnreadCount] failed:', err);
    return res.status(500).json({ error: 'Failed to count unread' });
  }
}

// ── Mark a conversation read ──────────────────────────────────────────
export async function markRead(req, res) {
  try {
    const me = currentUserId(req);
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid conversation id' });
    }

    const convo = await Conversation.findById(id);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    if (!convo.participants.map((p) => String(p)).includes(me)) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    await Message.updateMany(
      { conversation: id, sender: { $ne: me }, readBy: { $ne: me } },
      { $addToSet: { readBy: me } }
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[markRead] failed:', err);
    return res.status(500).json({ error: 'Failed to mark read' });
  }
}