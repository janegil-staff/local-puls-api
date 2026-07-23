// localpulse/server/src/controllers/chatController.js
//
// Chat controllers — SINGLE SOURCE OF TRUTH for persistence. Both web and
// mobile send via REST (POST /chat/conversations/:id/messages -> sendMessage).
// The controller saves the message, then emits it over the socket so the other
// participant gets it live.
//
// Conversation: { participants[], pairKey, status: 'pending'|'accepted',
//                 initiator, lastMessage: String, lastMessageAt }
// Message:      { conversation, sender, text?, imageUrl?, readBy[] } + toClient()
//
// NOTE: the pending "message request" gate has been REMOVED. Both participants
// can send freely regardless of convo.status. Conversations still carry
// status/initiator so the Requests vs Messages tabs and the accept action keep
// working as an informational/moderation surface, but sending is never blocked.
//
import mongoose from 'mongoose';
import Conversation, { buildPairKey } from '../models/Conversation.js';
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

// localpulse/server/src/controllers/chatController.js
// REPLACE the listConversations function with this version.
//
// WHY: the client (messages/page.js Row) already renders a per-conversation
// unread badge from `convo.unread`, but the server never sent that field, so
// the badge never appeared. Here we compute unread per conversation — messages
// in that thread not sent by me and not yet in my readBy — and include it on
// each row. Done with one aggregate over all the user's conversation ids rather
// than a countDocuments per row (which would be N queries).

export async function listConversations(req, res) {
  try {
    const me = currentUserId(req);
    // No .lean(): we need the User document methods (toPublic) so the avatar
    // resolves from photos[0] via the model's own serializer.
    const convos = await Conversation.find({ participants: me, status: 'accepted' })
      .sort({ lastMessageAt: -1 })
      .populate('participants');

    const ids = convos.map((c) => c._id);

    // One grouped count of unread messages across all these conversations,
    // keyed by conversation id — avoids a per-row query.
    const meId = new mongoose.Types.ObjectId(me);
    const unreadAgg = await Message.aggregate([
      { $match: { conversation: { $in: ids }, sender: { $ne: meId }, readBy: { $ne: meId } } },
      { $group: { _id: '$conversation', n: { $sum: 1 } } },
    ]);
    const unreadByConvo = new Map(unreadAgg.map((u) => [String(u._id), u.n]));

    const rows = convos.map((c) => {
      const other = (c.participants || []).find((p) => String(p._id) !== me);
      return {
        id: String(c._id),
        status: c.status,
        lastMessage: c.lastMessage,
        lastMessageAt: c.lastMessageAt,
        unread: unreadByConvo.get(String(c._id)) || 0,
        otherUser: other ? other.toPublic() : null,
        user: other ? other.toPublic() : null,
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
      .populate('participants');

    const rows = convos.map((c) => {
      const other = (c.participants || []).find((p) => String(p._id) !== me);
      return {
        id: String(c._id),
        lastMessage: c.lastMessage,
        lastMessageAt: c.lastMessageAt,
        otherUser: other ? other.toPublic() : null,
        user: other ? other.toPublic() : null,
      };
    });
    return res.json({ requests: rows });
  } catch (err) {
    console.error('[listRequests] failed:', err);
    return res.status(500).json({ error: 'Failed to load requests' });
  }
}

// ── Open (or re-open) a conversation with a user ──────────────────────
// Uses pairKey (sorted participant ids) so a pair can only ever resolve to one
// conversation. On the E11000 race (two opens at once), re-fetch the winner.
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

    const pairKey = buildPairKey(me, userId);

    // Fast path: the conversation already exists.
    let convo = await Conversation.findOne({ pairKey });

    if (!convo) {
      try {
        convo = await Conversation.create({
          participants: [me, userId],
          pairKey,
          initiator: me,
          status: 'pending',
        });
      } catch (err) {
        // E11000 = another request created it between our findOne and create.
        if (err?.code === 11000) {
          convo = await Conversation.findOne({ pairKey });
        } else {
          throw err;
        }
      }
    }

    if (!convo) return res.status(500).json({ error: 'Failed to open conversation' });
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

    const convo = await Conversation.findById(id).populate('participants');
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    if (!convo.participants.map((p) => String(p._id)).includes(me)) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    // The other participant — the chat header needs this to show name + avatar.
    // Deep-linking to /messages/:id doesn't load the list, so supply it here.
    const other = convo.participants.find((p) => String(p._id) !== me);
    const otherUser = other ? other.toPublic() : null;

    const query = { conversation: id };
    if (before) query.createdAt = { $lt: new Date(before) };

    const docs = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 100))
      .populate('sender');

    const messages = docs.reverse().map((m) => m.toClient());
    return res.json({
      messages,
      otherUser,
      user: otherUser,
      conversation: { id: String(convo._id), status: convo.status, initiator: String(convo.initiator) },
    });
  } catch (err) {
    console.error('[getMessages] failed:', err);
    return res.status(500).json({ error: 'Failed to load messages' });
  }
}
// localpulse/server/src/controllers/chatController.js
// REPLACE the chatUnreadCount function with this version.
//
// WHY: the old query counted unread messages only in status:'accepted'
// conversations. That was fine when the message-request gate blocked messages
// in pending threads — but the gate has been removed, so people can now send
// freely into pending conversations. Unread messages there were invisible to
// the badge, so a message from someone whose request you haven't accepted
// produced no unread count. Now we count unread across ALL of the user's
// conversations. We also return requestCount, which the web AppNav reads.

export async function chatUnreadCount(req, res) {
  try {
    const me = currentUserId(req);

    // ALL conversations the user is in — not just accepted. A message in a
    // still-pending thread is just as unread as one in an accepted thread.
    const convos = await Conversation.find({ participants: me }).select('_id');
    const ids = convos.map((c) => c._id);

    const count = await Message.countDocuments({
      conversation: { $in: ids },
      sender: { $ne: me },
      readBy: { $ne: me },
    });

    // Incoming requests awaiting this user's approval (pending, not initiated by
    // them). Returned so the client can show a combined or split badge without a
    // second round-trip.
    const requestCount = await Conversation.countDocuments({
      participants: me,
      status: 'pending',
      initiator: { $ne: me },
    });

    return res.json({ count, requestCount });
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