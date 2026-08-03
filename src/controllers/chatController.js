// localpulse/server/src/controllers/chatController.js
//
// Chat controllers — SINGLE SOURCE OF TRUTH for persistence. Both web and
// mobile send via REST (POST /chat/conversations/:id/messages -> sendMessage).
// The controller saves the message, then emits it over the socket so the other
// participant gets it live.
//
// Conversation: { participants[], pairKey, status: 'pending'|'accepted',
//                 initiator, lastMessage: String, lastMessageAt }
// Message:      { conversation, sender, text?, imageUrl?, readBy[], hiddenFor[] }
//               + toClient() / toAdmin()
//
// MESSAGE REQUESTS: a stranger gets ONE message before the recipient has
// accepted. Enforced in persistMessage via lib/pendingGuard.js, so both the
// REST path and any future socket path go through the same check.
//
// This gate was removed at one point and the logs showed the consequence
// immediately: two consecutive sends into a pending thread, both 201. Without
// it, "message requests" is a label on a screen rather than a protection.
//
// HIDING (hideMessage) is per-user and additive: a user's id goes into the
// message's hiddenFor array and every participant-facing READ filters on it.
// It is NOT a retraction — the other side still sees the message, and the
// document is never modified or removed, so moderation keeps the record. Three
// read paths filter, and all three are marked HIDDEN_FILTER below. Miss one
// and a hidden message returns through a side door.

import mongoose from "mongoose";
import Conversation, { buildPairKey } from "../models/Conversation.js";
import Message from "../models/Message.js";
import { checkPendingRules } from "../lib/pendingGuard.js";

function currentUserId(req) {
  return String(req.user.id || req.user.sub);
}

// Shared: persist a message + broadcast. Used by REST sendMessage.
// Returns { ok, message } or { status, error } for the caller to respond with.
//
// `error` is a TRANSLATION KEY for the request-gate rejections
// (chatPendingLimit), not a sentence — the app looks it up in its locale
// files. The other errors here are plain strings because they indicate bugs
// rather than states a user can act on.
async function persistMessage({
  req,
  conversationId,
  senderId,
  text,
  imageUrl,
}) {
  const convo = await Conversation.findById(conversationId);
  if (!convo) return { status: 404, error: "Conversation not found" };

  const participants = convo.participants.map((p) => String(p));
  if (!participants.includes(senderId)) {
    return { status: 403, error: "Not a participant" };
  }

  const isRecipient =
    convo.status === "pending" && String(convo.initiator) !== senderId;

  // A recipient replying to a request IS acceptance. Requiring them to tap
  // Accept and then type is a pointless extra step — they have plainly
  // decided they want to talk. The Accept button still exists for accepting
  // without replying.
  //
  // Flip BEFORE the guard runs, so checkPendingRules sees an accepted
  // conversation and lets the reply through. Removing this without also
  // handling the recipient in the guard leaves the thread deadlocked: the
  // initiator is out of messages and the recipient never accepted.
  //
  // NOTE this makes the recipient branch of checkPendingRules unreachable
  // from here — the guard returns chatPendingRecipient for a recipient, but a
  // recipient never arrives at it still pending. Same for pendingState(),
  // whose recipient answer (canSend: false) contradicts what actually happens.
  // getMessages below therefore computes canSend inline rather than calling
  // pendingState, and the divergence is worth resolving in pendingGuard.js
  // before anything else starts calling it.
  if (isRecipient) {
    convo.status = "accepted";
    await convo.save();

    const io = req.app.get("io");
    if (io) {
      participants.forEach((p) =>
        io
          .to(`user:${p}`)
          .emit("chat:accepted", { conversationId: String(convo._id) }),
      );
    }
  }

  const blocked = await checkPendingRules({ convo, senderId, Message });
  if (blocked) return { status: blocked.status, error: blocked.error };

  const message = await Message.create({
    conversation: convo._id,
    sender: senderId,
    ...(text ? { text: text.trim() } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    readBy: [senderId],
  });

  convo.lastMessage = text ? text.trim() : "📷";
  convo.lastMessageAt = message.createdAt;
  await convo.save();

  await message.populate("sender");
  const payload = message.toClient();

  // Broadcast live to anyone in the conversation room + notify the other side.
  const io = req.app.get("io");
  if (io) {
    io.to(`conversation:${convo._id}`).emit("chat:message", payload);
    participants
      .filter((p) => p !== senderId)
      .forEach((p) =>
        io.to(`user:${p}`).emit("chat:notify", {
          conversationId: String(convo._id),
        }),
      );
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
      return res.status(400).json({ error: "Invalid conversation id" });
    }
    if (!text?.trim() && !imageUrl) {
      return res.status(400).json({ error: "Message is empty" });
    }

    const result = await persistMessage({
      req,
      conversationId: id,
      senderId: me,
      text,
      imageUrl,
    });
    if (result.error)
      return res.status(result.status).json({ error: result.error });

    return res.status(201).json({ message: result.message });
  } catch (err) {
    console.error("[sendMessage] failed:", err);
    return res.status(500).json({ error: "Failed to send message" });
  }
}

// ── Hide a single message for the calling user ────────────────────────
//
// "Delete for me", not a retraction. $addToSet on hiddenFor; the document is
// never modified otherwise and never removed.
//
// Idempotent: hiding twice is a no-op, so a double-click or a retried request
// cannot corrupt the array.
//
// No socket broadcast, deliberately. The change affects exactly one user's
// view, and the other participant must NOT be told — an event saying "message
// hidden" would leak that you removed something, which is precisely what
// delete-for-me is not. The cost is that a second tab of the same account will
// not update until it reloads; acceptable for a deliberate manual action.
//
// There is NO unhide endpoint. Adding one without a UI listing what you have
// hidden would make it unreachable, and the client confirms before calling
// this because of that.
export async function hideMessage(req, res) {
  try {
    const me = currentUserId(req);
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid message id" });
    }

    const msg = await Message.findById(id).select("_id conversation");
    if (!msg) return res.status(404).json({ error: "Message not found" });

    // Membership check. Hiding is per-user, but you must be in the thread to
    // touch anything in it — without this, any id could be probed for
    // existence by watching 404 vs 200.
    const convo = await Conversation.findOne({
      _id: msg.conversation,
      participants: me,
    }).select("_id");
    if (!convo) return res.status(403).json({ error: "Not a participant" });

    await Message.updateOne({ _id: id }, { $addToSet: { hiddenFor: me } });

    return res.json({ ok: true, messageId: String(id) });
  } catch (err) {
    console.error("[hideMessage] failed:", err);
    return res.status(500).json({ error: "Failed to hide message" });
  }
}

// ── Accepted conversations, with a per-conversation unread count ──────
//
// The client's Row renders `convo.unread`, so it has to be supplied here.
// Computed with ONE aggregate over all the user's conversation ids rather
// than a countDocuments per row, which would be N queries for a list.
export async function listConversations(req, res) {
  try {
    const me = currentUserId(req);

    // No .lean(): we need the User document methods (toPublic) so the avatar
    // resolves from photos[0] via the model's own serializer.
    const convos = await Conversation.find({
      participants: me,
      status: "accepted",
    })
      .sort({ lastMessageAt: -1 })
      .populate("participants");

    const ids = convos.map((c) => c._id);

    // Cast explicitly: aggregate does NOT run values through the schema, so a
    // raw string here silently matches nothing and every count comes back
    // zero. countDocuments elsewhere in this file gets away with a string
    // because Mongoose casts it — aggregate does not. The same applies to the
    // hiddenFor filter below, which is why it uses meId and not me.
    const meId = new mongoose.Types.ObjectId(me);

    const unreadAgg = await Message.aggregate([
      {
        $match: {
          conversation: { $in: ids },
          sender: { $ne: meId },
          readBy: { $ne: meId },
          // HIDDEN_FILTER 1 of 3 — a message I hid must not keep a row bolded
          // with a count I cannot clear by opening the thread.
          hiddenFor: { $ne: meId },
        },
      },
      { $group: { _id: "$conversation", n: { $sum: 1 } } },
    ]);
    const unreadByConvo = new Map(unreadAgg.map((u) => [String(u._id), u.n]));

    const rows = convos.map((c) => {
      const other = (c.participants || []).find((p) => String(p._id) !== me);
      return {
        id: String(c._id),
        status: c.status,
        // KNOWN LIMITATION: lastMessage is denormalised onto the conversation
        // by persistMessage, so hiding the newest message does NOT change this
        // preview — the inbox row still shows its text until someone sends
        // again. Fixing it properly means resolving the newest non-hidden
        // message per conversation, which is a second aggregate over the whole
        // list. Left as-is deliberately; revisit if it bothers anyone.
        lastMessage: c.lastMessage,
        lastMessageAt: c.lastMessageAt,
        unread: unreadByConvo.get(String(c._id)) || 0,
        otherUser: other ? other.toPublic() : null,
        user: other ? other.toPublic() : null,
      };
    });

    return res.json({ conversations: rows });
  } catch (err) {
    console.error("[listConversations] failed:", err);
    return res.status(500).json({ error: "Failed to load conversations" });
  }
}

// ── List pending requests awaiting this user's approval ───────────────
export async function listRequests(req, res) {
  try {
    const me = currentUserId(req);
    const convos = await Conversation.find({
      participants: me,
      status: "pending",
      initiator: { $ne: me },
    })
      .sort({ lastMessageAt: -1 })
      .populate("participants");

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
    console.error("[listRequests] failed:", err);
    return res.status(500).json({ error: "Failed to load requests" });
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
      return res.status(400).json({ error: "Invalid user id" });
    }
    if (String(userId) === me) {
      return res.status(400).json({ error: "Cannot message yourself" });
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
          status: "pending",
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

    if (!convo)
      return res.status(500).json({ error: "Failed to open conversation" });

    return res.json({
      conversationId: String(convo._id),
      status: convo.status,
    });
  } catch (err) {
    console.error("[openConversation] failed:", err);
    return res.status(500).json({ error: "Failed to open conversation" });
  }
}

// ── Accept a pending request (recipient only) ─────────────────────────
//
// Still needed even though replying auto-accepts: accepting without replying
// is a distinct action, and it is what moves the row from Requests into
// Messages before the user has decided what to say.
export async function acceptConversation(req, res) {
  try {
    const me = currentUserId(req);
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid conversation id" });
    }

    const convo = await Conversation.findById(id);
    if (!convo)
      return res.status(404).json({ error: "Conversation not found" });

    const participants = convo.participants.map((p) => String(p));
    if (!participants.includes(me)) {
      return res.status(403).json({ error: "Not a participant" });
    }
    if (String(convo.initiator) === me) {
      return res.status(400).json({ error: "Cannot accept your own request" });
    }

    if (convo.status !== "accepted") {
      convo.status = "accepted";
      await convo.save();
    }

    const io = req.app.get("io");
    if (io) {
      participants.forEach((p) =>
        io
          .to(`user:${p}`)
          .emit("chat:accepted", { conversationId: String(convo._id) }),
      );
    }

    return res.json({
      ok: true,
      status: convo.status,
      conversationId: String(convo._id),
    });
  } catch (err) {
    console.error("[acceptConversation] failed:", err);
    return res.status(500).json({ error: "Failed to accept conversation" });
  }
}

// ── Message history ───────────────────────────────────────────────────
export async function getMessages(req, res) {
  try {
    const me = currentUserId(req);
    const { id } = req.params;
    const { before, limit = 50 } = req.query;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid conversation id" });
    }

    const convo = await Conversation.findById(id).populate("participants");
    if (!convo)
      return res.status(404).json({ error: "Conversation not found" });
    if (!convo.participants.map((p) => String(p._id)).includes(me)) {
      return res.status(403).json({ error: "Not a participant" });
    }

    // The other participant — the chat header needs this to show name + avatar.
    // Deep-linking to /messages/:id doesn't load the list, so supply it here.
    const other = convo.participants.find((p) => String(p._id) !== me);
    const otherUser = other ? other.toPublic() : null;

    // HIDDEN_FILTER 2 of 3 — the thread itself. Without this the message
    // reappears the moment the page reloads, which is the most obvious of the
    // three and still the easiest to forget.
    const query = { conversation: id, hiddenFor: { $ne: me } };
    if (before) query.createdAt = { $lt: new Date(before) };

    const docs = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 100))
      .populate("sender");

    const messages = docs.reverse().map((m) => m.toClient());

    // Whether this user may send right now, so the input can be disabled
    // BEFORE they type rather than after the send is rejected. Only the
    // initiator of a still-pending thread is ever limited — a recipient
    // replying accepts the conversation, so they always can.
    //
    // Computed inline rather than via pendingState() from pendingGuard.js:
    // that helper answers canSend: false for a recipient, which contradicts
    // the auto-accept in persistMessage. Reconcile the two before switching.
    //
    // DELIBERATELY NOT filtered by hiddenFor. Hiding your own opening message
    // must not buy you another one — the count is of what was SENT, not of
    // what you can still see. checkPendingRules counts the same way, so the
    // client's view and the server's gate agree.
    const isInitiator = String(convo.initiator) === me;
    let canSend = true;
    let sendBlockedReason = null;

    if (convo.status === "pending" && isInitiator) {
      const sent = await Message.countDocuments({
        conversation: convo._id,
        sender: me,
      });
      canSend = sent < 1;
      sendBlockedReason = canSend ? null : "chatPendingLimit";
    }

    return res.json({
      messages,
      otherUser,
      user: otherUser,
      conversation: {
        id: String(convo._id),
        status: convo.status,
        initiator: String(convo.initiator),
        canSend,
        sendBlockedReason,
      },
    });
  } catch (err) {
    console.error("[getMessages] failed:", err);
    return res.status(500).json({ error: "Failed to load messages" });
  }
}

// ── Unread + request counts for the ✉ badge ───────────────────────────
//
// `count` deliberately covers ACCEPTED conversations only, and requestCount
// covers pending ones. The client adds them together for a single badge — so
// counting unread across all conversations would double-count: a pending
// thread with one unread message would contribute 1 to each, and the badge
// would read 2 for one waiting person.
//
// The two are returned separately rather than pre-summed so the client can
// also show them apart, which the Messages screen does.
export async function chatUnreadCount(req, res) {
  try {
    const me = currentUserId(req);

    const convos = await Conversation.find({
      participants: me,
      status: "accepted",
    }).select("_id");

    const count = await Message.countDocuments({
      conversation: { $in: convos.map((c) => c._id) },
      // My own messages are never unread — readBy already contains the
      // sender, but excluding explicitly means a bug in that write cannot
      // inflate the badge.
      sender: { $ne: me },
      readBy: { $ne: me },
      // HIDDEN_FILTER 3 of 3 — the one people forget. Without it the ✉ badge
      // shows a count for a message the user cannot find anywhere, and no
      // amount of opening threads clears it. Reads as a broken badge.
      hiddenFor: { $ne: me },
    });

    // Incoming requests awaiting this user's approval.
    //
    // Counts CONVERSATIONS, not messages, so a request with no message yet
    // still lights the badge. openConversation creates the thread the moment
    // someone presses Message on a profile, which means an abandoned tap
    // leaves a permanent empty request in the recipient's list. Worth making
    // creation lazy — on first send — or excluding zero-message threads here.
    const requestCount = await Conversation.countDocuments({
      participants: me,
      status: "pending",
      initiator: { $ne: me },
    });

    return res.json({ count, requestCount });
  } catch (err) {
    console.error("[chatUnreadCount] failed:", err);
    return res.status(500).json({ error: "Failed to count unread" });
  }
}

// ── Mark a conversation read ──────────────────────────────────────────
export async function markRead(req, res) {
  try {
    const me = currentUserId(req);
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid conversation id" });
    }

    const convo = await Conversation.findById(id);
    if (!convo)
      return res.status(404).json({ error: "Conversation not found" });
    if (!convo.participants.map((p) => String(p)).includes(me)) {
      return res.status(403).json({ error: "Not a participant" });
    }

    // Not filtered by hiddenFor: marking a hidden message read is harmless and
    // keeps readBy honest for the sender's future read receipts, if those ever
    // land. The badge already excludes hidden messages at the count.
    await Message.updateMany(
      { conversation: id, sender: { $ne: me }, readBy: { $ne: me } },
      { $addToSet: { readBy: me } },
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("[markRead] failed:", err);
    return res.status(500).json({ error: "Failed to mark read" });
  }
}
