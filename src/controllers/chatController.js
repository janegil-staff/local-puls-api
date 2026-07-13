// localpulse/server/src/controllers/chatController.js
//
// Block checks come from lib/blocks.js — do NOT redeclare them here. This file
// previously carried its own copies, which is how getMessages ended up with no
// check at all while openConversation had one.
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { blockedBetween, blockedIdsFor } from '../lib/blocks.js';

// Load a conversation and assert the viewer may see it: they must be a
// participant, and there must be no block in either direction.
//
// Returns { convo } on success, or { status, error } to send. 404 rather than
// 403 for blocks — a blocked user should not learn the thread still exists.
//
// EVERY handler taking a :id must go through this. getMessages previously did
// no participation check at all: any authenticated user could read any
// conversation by guessing its ObjectId.
async function loadVisibleConversation(convoId, viewerId) {
  const convo = await Conversation.findById(convoId);
  if (!convo) return { status: 404, error: 'Conversation not found' };

  const isParticipant = convo.participants.some((p) => String(p) === String(viewerId));
  if (!isParticipant) return { status: 404, error: 'Conversation not found' };

  const other = convo.participants.find((p) => String(p) !== String(viewerId));
  if (other && (await blockedBetween(viewerId, other))) {
    return { status: 404, error: 'Conversation not found' };
  }
  return { convo };
}

// Shape a conversation for the client (other participant + meta).
//
// The client reads a single `otherUser` (name, avatar, chat title), so we
// resolve the non-viewer participant and send it under that key. `participants`
// is kept for any caller that still expects the filtered array.
function shapeConvo(c, viewerId) {
  const others = c.participants
    .filter((p) => String(p._id) !== String(viewerId))
    .map((p) => (p.toPublic ? p.toPublic() : p));
  return {
    id: c._id,
    status: c.status,
    isInitiator: String(c.initiator) === String(viewerId),
    otherUser: others[0] || null,
    participants: others,
    lastMessage: c.lastMessage,
    lastMessageAt: c.lastMessageAt,
  };
}

// Main inbox: ACCEPTED conversations the viewer is part of, each with an
// unread count (messages the viewer hasn't read, not sent by them).
export async function listConversations(req, res) {
  try {
    // $all pins the viewer as a participant; $nin drops any conversation whose
    // other participant is blocked. Correct for 2-party threads.
    const blockedIds = await blockedIdsFor(req.userId);
    const convos = await Conversation.find({
      participants: { $all: [req.userId], $nin: blockedIds },
      status: { $ne: 'pending' },
    })
      .sort({ lastMessageAt: -1 })
      .populate('participants');

    const shaped = await Promise.all(
      convos.map(async (c) => {
        const unread = await Message.countDocuments({
          conversation: c._id,
          sender: { $ne: req.userId },
          readBy: { $ne: req.userId },
        });
        return { ...shapeConvo(c, req.userId), unread };
      })
    );
    return res.json({ conversations: shaped });
  } catch (err) {
    console.error('listConversations error', err);
    return res.status(500).json({ error: 'Could not load conversations' });
  }
}

// Total unread across all accepted conversations — for the tab badge.
// Must exclude blocked threads, or the badge counts messages the user cannot
// open: a permanent unread count with nowhere to go.
export async function chatUnreadCount(req, res) {
  try {
    const blockedIds = await blockedIdsFor(req.userId);
    const convos = await Conversation.find({
      participants: { $all: [req.userId], $nin: blockedIds },
      status: { $ne: 'pending' },
    }).select('_id');
    const ids = convos.map((c) => c._id);
    const count = await Message.countDocuments({
      conversation: { $in: ids },
      sender: { $ne: req.userId },
      readBy: { $ne: req.userId },
    });
    return res.json({ count });
  } catch (err) {
    console.error('unreadCount error', err);
    return res.status(500).json({ error: 'Could not load unread count' });
  }
}

// Mark all messages in a conversation as read by the viewer.
export async function markRead(req, res) {
  try {
    const { convo, status, error } = await loadVisibleConversation(req.params.id, req.userId);
    if (!convo) return res.status(status).json({ error });

    await Message.updateMany(
      { conversation: convo._id, readBy: { $ne: req.userId } },
      { $addToSet: { readBy: req.userId } }
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('markRead error', err);
    return res.status(500).json({ error: 'Could not mark read' });
  }
}

// Requests inbox: PENDING conversations where the viewer is the RECIPIENT
// (i.e. someone else started it). The initiator does not see their own
// outgoing requests here.
export async function listRequests(req, res) {
  try {
    const blockedIds = await blockedIdsFor(req.userId);
    const convos = await Conversation.find({
      participants: { $all: [req.userId], $nin: blockedIds },
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
    const { convo, status, error } = await loadVisibleConversation(req.params.id, req.userId);
    if (!convo) return res.status(status).json({ error });

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
    const { convo, status, error } = await loadVisibleConversation(req.params.id, req.userId);
    if (!convo) return res.status(status).json({ error });

    const { before, limit } = req.query;
    const lim = Math.min(Number(limit) || 30, 50);
    const messages = await Message.find({
      conversation: convo._id,
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