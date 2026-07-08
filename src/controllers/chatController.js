// localpulse/server/src/controllers/chatController.js
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Block from '../models/Block.js';

// Helper: is there a block in either direction between two users?
async function blockedBetween(a, b) {
  const block = await Block.findOne({
    $or: [
      { blocker: a, blocked: b },
      { blocker: b, blocked: a },
    ],
  });
  return Boolean(block);
}

// Shape a conversation for the client (other participant + meta).
function shapeConvo(c, viewerId) {
  return {
    id: c._id,
    status: c.status,
    isInitiator: String(c.initiator) === String(viewerId),
    participants: c.participants
      .filter((p) => String(p._id) !== String(viewerId))
      .map((p) => (p.toPublic ? p.toPublic() : p)),
    lastMessage: c.lastMessage,
    lastMessageAt: c.lastMessageAt,
  };
}

// Main inbox: ACCEPTED conversations the viewer is part of.
export async function listConversations(req, res) {
  try {
    const convos = await Conversation.find({
      participants: req.userId,
      status: 'accepted',
    })
      .sort({ lastMessageAt: -1 })
      .populate('participants');
    return res.json({ conversations: convos.map((c) => shapeConvo(c, req.userId)) });
  } catch (err) {
    console.error('listConversations error', err);
    return res.status(500).json({ error: 'Could not load conversations' });
  }
}

// Requests inbox: PENDING conversations where the viewer is the RECIPIENT
// (i.e. someone else started it). The initiator does not see their own
// outgoing requests here.
export async function listRequests(req, res) {
  try {
    const convos = await Conversation.find({
      participants: req.userId,
      status: 'pending',
      initiator: { $ne: req.userId },
    })
      .sort({ lastMessageAt: -1 })
      .populate('participants');
    return res.json({ requests: convos.map((c) => shapeConvo(c, req.userId)) });
  } catch (err) {
    console.error('listRequests error', err);
    return res.status(500).json({ error: 'Could not load requests' });
  }
}

// Find-or-create a 1:1 conversation with another user.
// New conversations start as 'pending' with the caller as initiator.
export async function openConversation(req, res) {
  try {
    const otherId = req.params.userId;
    if (String(otherId) === String(req.userId)) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }
    if (await blockedBetween(req.userId, otherId)) {
      return res.status(403).json({ error: 'You cannot message this user' });
    }
    let convo = await Conversation.findOne({
      participants: { $all: [req.userId, otherId], $size: 2 },
    });
    if (!convo) {
      convo = await Conversation.create({
        participants: [req.userId, otherId],
        status: 'pending',
        initiator: req.userId,
      });
    }
    return res.json({ conversationId: convo._id, status: convo.status });
  } catch (err) {
    console.error('openConversation error', err);
    return res.status(500).json({ error: 'Could not open conversation' });
  }
}

// Recipient accepts a pending conversation → moves it to the main inbox.
export async function acceptConversation(req, res) {
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    const isParticipant = convo.participants.some((p) => String(p) === String(req.userId));
    if (!isParticipant) return res.status(403).json({ error: 'Not your conversation' });
    // Only the recipient (not the initiator) can accept.
    if (String(convo.initiator) === String(req.userId)) {
      return res.status(400).json({ error: 'You started this conversation' });
    }
    convo.status = 'accepted';
    await convo.save();
    return res.json({ ok: true, conversationId: convo._id, status: convo.status });
  } catch (err) {
    console.error('acceptConversation error', err);
    return res.status(500).json({ error: 'Could not accept conversation' });
  }
}

// Message history for a conversation (paginated with ?before=).
export async function getMessages(req, res) {
  try {
    const { before, limit } = req.query;
    const lim = Math.min(Number(limit) || 30, 50);
    const messages = await Message.find({
      conversation: req.params.id,
      ...(before ? { createdAt: { $lt: new Date(before) } } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(lim)
      .populate('sender');
    // Return chronological.
    return res.json({ messages: messages.reverse().map((m) => m.toClient()) });
  } catch (err) {
    console.error('getMessages error', err);
    return res.status(500).json({ error: 'Could not load messages' });
  }
}