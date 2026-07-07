// localpulse/server/src/controllers/chatController.js
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';

// All conversations the viewer is part of, most-recent first.
export async function listConversations(req, res) {
  try {
    const convos = await Conversation.find({ participants: req.userId })
      .sort({ lastMessageAt: -1 })
      .populate('participants');
    return res.json({
      conversations: convos.map((c) => ({
        id: c._id,
        participants: c.participants
          .filter((p) => String(p._id) !== String(req.userId))
          .map((p) => (p.toPublic ? p.toPublic() : p)),
        lastMessage: c.lastMessage,
        lastMessageAt: c.lastMessageAt,
      })),
    });
  } catch (err) {
    console.error('listConversations error', err);
    return res.status(500).json({ error: 'Could not load conversations' });
  }
}

// Find-or-create a 1:1 conversation with another user.
export async function openConversation(req, res) {
  try {
    const otherId = req.params.userId;
    if (String(otherId) === String(req.userId)) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }
    let convo = await Conversation.findOne({
      participants: { $all: [req.userId, otherId], $size: 2 },
    });
    if (!convo) {
      convo = await Conversation.create({ participants: [req.userId, otherId] });
    }
    return res.json({ conversationId: convo._id });
  } catch (err) {
    console.error('openConversation error', err);
    return res.status(500).json({ error: 'Could not open conversation' });
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
