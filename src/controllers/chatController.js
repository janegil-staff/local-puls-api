// local-pulse-api/src/controllers/chatController.js
//
// Block checks come from lib/blocks.js — do NOT redeclare them here. This file
// previously carried its own copies, which is how getMessages ended up with no
// check at all while openConversation had one.
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { blockedBetween, blockedIdsFor } from '../lib/blocks.js';

// ─── The three chat queries are deliberately NOT identical ───────────────────
//
// They look similar enough to invite "syncing" them. Don't. Each backs a
// different surface, and a pending conversation the viewer did NOT start
// belongs to exactly one of them:
//
//   listConversations  → Inbox tab.     Accepted + the viewer's OWN outgoing
//                                       pending. Incoming requests stay OUT.
//   listRequests       → Requests tab.  ONLY incoming pending.
//   chatUnreadCount    → the nav badge. BOTH tabs, because the badge sits
//                                       above both — so it needs no status
//                                       filter at all (see below).
//
// `{ status: 'pending', initiator: { $ne: req.userId } }` is correct in
// listRequests, and WRONG in listConversations — putting it there renders every
// message request twice: once in Inbox, once in Requests. That bug shipped
// once already. The comments below repeat this at each site on purpose.

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

// INBOX tab. See the header note: this query must NOT match incoming requests.
export async function listConversations(req, res) {
  try {
    const blockedIds = await blockedIdsFor(req.userId);
    const convos = await Conversation.find({
      participants: { $all: [req.userId], $nin: blockedIds },
      // Accepted threads, PLUS pending ones the viewer started. A bare
      // `status: { $ne: 'pending' }` hid the initiator's own outgoing request
      // from them entirely: they could send into it, but it was invisible in
      // their inbox until the recipient accepted.
      //
      // Incoming pending threads stay OUT — they belong to listRequests. A
      // third clause matching `initiator: { $ne: req.userId }` was added here
      // by mistake and showed every request in BOTH tabs.
      $or: [
        { status: { $ne: 'pending' } },
        { status: 'pending', initiator: req.userId },
      ],
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

// NAV BADGE. One number spanning every thread reachable from /messages — which
// is BOTH tabs on that page (Inbox and Requests).
//
// NO STATUS FILTER, AND NO $or. This is deliberate and hard-won:
//
// Every conversation the viewer participates in (minus blocks) is reachable
// from /messages — accepted and own-outgoing-pending land in the Inbox tab,
// incoming-pending lands in the Requests tab. There is no fourth category, so
// there is nothing for a status filter to exclude. The participants clause
// alone is already the exact set.
//
// An earlier version carried a three-branch $or mirroring the two list queries.
// It silently returned ONLY the pending threads: every accepted conversation
// vanished from the badge, so a real unread message counted as zero. Each
// branch matched correctly in isolation ($ne:'pending' alone found both
// accepted threads) but combining them under $or alongside $all/$nin on the
// same `participants` array field dropped them. listConversations gets away
// with a similar shape because its $or has two branches, not three — which is
// luck, not design. Do not reintroduce an $or here; it is not needed, and it
// broke this endpoint for weeks.
//
// The status/initiator split happens in JS below, where it is explicit and
// cannot be miscompiled by the query planner.
//
// `count` is the combined total the badge renders. `requestCount` breaks out
// the pending-request share so the client can split the badge into two
// indicators later without a server change. The client tolerates its absence
// (`data.requestCount || 0`), so it is additive.
export async function chatUnreadCount(req, res) {
  try {
    const blockedIds = await blockedIdsFor(req.userId);

    const convos = await Conversation.find({
      participants: { $all: [req.userId], $nin: blockedIds },
    }).select('_id status initiator');

    // Partition into the two tabs. `status` is a strict enum and `initiator` is
    // always set by openConversation, so these are disjoint and exhaustive — no
    // thread can be double-counted or dropped.
    const isRequest = (c) =>
      c.status === 'pending' && String(c.initiator) !== String(req.userId);

    const requestIds = convos.filter(isRequest).map((c) => c._id);
    const inboxIds = convos.filter((c) => !isRequest(c)).map((c) => c._id);

    const unreadIn = (ids) =>
      ids.length
        ? Message.countDocuments({
            conversation: { $in: ids },
            sender: { $ne: req.userId },
            readBy: { $ne: req.userId },
          })
        : Promise.resolve(0);

    const [inboxCount, requestCount] = await Promise.all([
      unreadIn(inboxIds),
      unreadIn(requestIds),
    ]);

    return res.json({ count: inboxCount + requestCount, requestCount });
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

// REQUESTS tab: PENDING conversations where the viewer is the RECIPIENT (i.e.
// someone else started it). The initiator does not see their own outgoing
// requests here — those show in their Inbox via listConversations.
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

    // Tell the INITIATOR their request went through. Without this their open
    // thread page sits on a stale 'pending': the composer stays locked and the
    // image button stays disabled until they happen to reload. Goes to the
    // personal room (joined on connect in socket/chat.js), so it reaches them
    // wherever they are in the app, not only on the thread page.
    //
    // Optional-chained: if app.set('io') is ever dropped from server.js this
    // degrades to the old reload-to-unlock behaviour rather than 500ing an
    // accept that already succeeded.
    req.app.get('io')?.to(`user:${convo.initiator}`).emit('chat:accepted', {
      conversationId: String(convo._id),
      status: convo.status,
    });

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