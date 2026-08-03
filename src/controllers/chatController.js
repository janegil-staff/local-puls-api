// localpulse/server/src/controllers/chatController.js
//
// Chat controllers — SINGLE SOURCE OF TRUTH for persistence. Both web and
// mobile send via REST (POST /chat/conversations/:id/messages -> sendMessage).
//
// Conversation: { participants[], pairKey, status: 'pending'|'accepted',
//                 initiator, lastMessage: String, lastMessageAt }
// Message:      { conversation, sender, text?, imageUrl?, readBy[], hiddenFor[],
//                 retractedAt?, removedByAdmin? } + toClient(viewerId)/toAdmin()
//
// MESSAGE REQUESTS: a stranger gets ONE message before the recipient has
// accepted. Enforced in persistMessage via lib/pendingGuard.js. This gate was
// removed at one point and the logs showed two consecutive sends into a
// pending thread, both 201 — without it, "message requests" is a label on a
// screen rather than a protection.
//
// THREE WAYS A MESSAGE STOPS BEING VISIBLE, and they are not the same thing:
//
//   hiddenFor[]     one-sided, per-user, irreversible. Used on the OTHER
//                   party's messages; they keep their copy.
//   retractedAt     the SENDER withdrawing their own message. Gone for BOTH,
//                   no tombstone, no time limit.
//   removedByAdmin  a moderator decision. Both parties, has an author,
//                   reversible. Sender sees a tombstone; recipient sees
//                   nothing.
//
// None deletes or edits the document. Reports stay actionable, admins keep the
// record, restore stays possible.
//
// Every participant-facing read carries the same three clauses and is marked
// PARTICIPANT_FILTER below. There are three. Missing one lets a message back
// through a side door. Admin reads carry NONE of them.

import mongoose from "mongoose";
import Conversation, { buildPairKey } from "../models/Conversation.js";
import Message from "../models/Message.js";
import Report, { REPORT_REASONS } from "../models/Report.js";
import { checkPendingRules } from "../lib/pendingGuard.js";

function currentUserId(req) {
  return String(req.user.id || req.user.sub);
}

// The visibility clauses, in one place. `me` is a string id.
//
// retracted: gone for everyone including the sender — they asked for it gone.
// removed:   gone for everyone EXCEPT the sender, who gets a tombstone.
// hidden:    gone for whoever hid it.
function visibleTo(me) {
  return {
    hiddenFor: { $ne: me },
    retractedAt: { $exists: false },
    $or: [{ "removedByAdmin.at": { $exists: false } }, { sender: me }],
  };
}

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

  // A recipient replying to a request IS acceptance. Flip BEFORE the guard so
  // checkPendingRules sees an accepted conversation and lets the reply
  // through; without this the thread deadlocks, with the initiator out of
  // messages and the recipient never having accepted.
  //
  // This also makes the recipient branch of checkPendingRules — and
  // pendingState(), whose recipient answer contradicts it — unreachable from
  // here. getMessages computes canSend inline for that reason. Worth
  // reconciling in pendingGuard.js before anything else calls it.
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
  const payload = message.toClient(String(senderId));

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

// Shared membership check for the per-message actions below.
//
// 404-before-403 leaks existence to a non-participant, but both branches
// return before revealing content and the ids are random ObjectIds, so it is
// not worth an extra query to close.
async function findMessageForParticipant(messageId, userId) {
  if (!mongoose.isValidObjectId(messageId)) {
    return { status: 400, error: "Invalid message id" };
  }

  const msg = await Message.findById(messageId).select(
    "_id conversation sender text imageUrl retractedAt",
  );
  if (!msg) return { status: 404, error: "Message not found" };

  const convo = await Conversation.findOne({
    _id: msg.conversation,
    participants: userId,
  }).select("_id");
  if (!convo) return { status: 403, error: "Not a participant" };

  return { msg };
}

// ── Hide a message for the calling user only ──────────────────────────
//
// "Delete for me". For the OTHER party's messages — the sender's own go
// through retractMessage instead, which removes them for both.
//
// Idempotent via $addToSet. No socket broadcast, deliberately: the change is
// one user's view, and telling the other side would leak that you removed
// something, which is exactly what delete-for-me is not. Cost is that a second
// tab of the same account waits for a reload.
//
// No unhide endpoint. Adding one without a UI listing what you hid would make
// it unreachable, which is why the client confirms first.
export async function hideMessage(req, res) {
  try {
    const me = currentUserId(req);
    const found = await findMessageForParticipant(req.params.id, me);
    if (found.error)
      return res.status(found.status).json({ error: found.error });

    await Message.updateOne(
      { _id: found.msg._id },
      { $addToSet: { hiddenFor: me } },
    );

    return res.json({ ok: true, messageId: String(found.msg._id) });
  } catch (err) {
    console.error("[hideMessage] failed:", err);
    return res.status(500).json({ error: "Failed to hide message" });
  }
}

// ── Retract your own message — removes it for BOTH parties ────────────
//
// No time window: a message can be withdrawn at any point after sending.
//
// That is a deliberate product choice with a real cost, worth restating where
// the code lives. Reporting requires seeing the message, so unrestricted
// retraction means something can be sent and erased before the recipient can
// file anything. The two mitigations here are the only ones:
//
//   1. The document is never deleted. Text and retractedAt persist, and
//      toAdmin() surfaces both, so an admin can still see what was sent.
//   2. A message that has ALREADY been reported cannot be retracted — an open
//      complaint must not have its subject vanish underneath it. Remove the
//      Report lookup below if you want retraction to be unconditional; it
//      affects only messages someone has actively complained about.
//
// Sender-only: retracting someone else's message would be a delete-for-them
// button, which is not a thing this app should have.
export async function retractMessage(req, res) {
  try {
    const me = currentUserId(req);
    const found = await findMessageForParticipant(req.params.id, me);
    if (found.error)
      return res.status(found.status).json({ error: found.error });

    const msg = found.msg;

    if (String(msg.sender) !== me) {
      return res.status(403).json({ error: "Not your message" });
    }

    // Idempotent: retracting twice is a second button press, not an error.
    if (msg.retractedAt) {
      return res.json({ ok: true, messageId: String(msg._id), already: true });
    }

    const reported = await Report.findOne({ message: msg._id }).select("_id");
    if (reported) {
      return res.status(409).json({ error: "chatRetractReported" });
    }

    await Message.updateOne(
      { _id: msg._id },
      { $set: { retractedAt: new Date() } },
    );

    // Both clients drop it live. Sent to the conversation room, so anyone with
    // the thread open sees it go without a reload.
    const io = req.app.get("io");
    if (io) {
      io.to(`conversation:${msg.conversation}`).emit("chat:message:retracted", {
        conversationId: String(msg.conversation),
        messageId: String(msg._id),
      });
    }

    return res.json({ ok: true, messageId: String(msg._id) });
  } catch (err) {
    console.error("[retractMessage] failed:", err);
    return res.status(500).json({ error: "Failed to retract message" });
  }
}

// ── Report a single message ───────────────────────────────────────────
//
// Reaches the same moderation queue as post and user reports. reportedUser is
// set to the sender so group-by-user views pick these up unchanged.
//
// snapshotText captures the text as reported — messages are not editable
// today, but a report re-reading the live document would be worthless the day
// they are.
//
// Filing twice returns 200 with duplicate: true, not a 409; the unique sparse
// index on { reporter, message } makes that hold under a race.
//
// Reporting is NOT blocked by hiddenFor: you can report a message you hid.
// Retracted messages cannot be reported, because they are gone from the
// reporter's thread before they could press the button — see retractMessage.
export async function reportMessage(req, res) {
  try {
    const me = currentUserId(req);
    const { reason, note } = req.body || {};

    // Validated here rather than in validate(), whose schema DSL has no enum
    // support — an unknown reason would reach Mongoose and surface as a 500.
    if (!REPORT_REASONS.includes(reason)) {
      return res.status(400).json({ error: "Invalid reason" });
    }

    const found = await findMessageForParticipant(req.params.id, me);
    if (found.error)
      return res.status(found.status).json({ error: found.error });

    const msg = found.msg;

    if (String(msg.sender) === me) {
      return res.status(400).json({ error: "Cannot report your own message" });
    }

    const existing = await Report.findOne({ reporter: me, message: msg._id });
    if (existing) {
      return res.json({
        ok: true,
        reportId: String(existing._id),
        duplicate: true,
      });
    }

    const report = await Report.create({
      reporter: me,
      message: msg._id,
      conversation: msg.conversation,
      reportedUser: msg.sender,
      snapshotText: msg.text || (msg.imageUrl ? "[image]" : ""),
      reason,
      note: typeof note === "string" ? note.slice(0, 500) : "",
    });

    return res
      .status(201)
      .json({ ok: true, reportId: String(report._id), duplicate: false });
  } catch (err) {
    if (err?.code === 11000) {
      return res.json({ ok: true, duplicate: true });
    }
    console.error("[reportMessage] failed:", err);
    return res.status(500).json({ error: "Failed to report message" });
  }
}

// ── Accepted conversations, with a per-conversation unread count ──────
export async function listConversations(req, res) {
  try {
    const me = currentUserId(req);

    // No .lean(): we need toPublic() so the avatar resolves from photos[0].
    const convos = await Conversation.find({
      participants: me,
      status: "accepted",
    })
      .sort({ lastMessageAt: -1 })
      .populate("participants");

    const ids = convos.map((c) => c._id);

    // Cast explicitly: aggregate does NOT run values through the schema, so a
    // raw string matches nothing and every count comes back zero.
    // countDocuments elsewhere gets away with a string because Mongoose casts
    // it — aggregate does not.
    const meId = new mongoose.Types.ObjectId(me);

    const unreadAgg = await Message.aggregate([
      {
        $match: {
          conversation: { $in: ids },
          sender: { $ne: meId },
          readBy: { $ne: meId },
          // PARTICIPANT_FILTER 1 of 3. Everything counted here is someone
          // else's message, so removal needs no sender exception — a
          // recipient never sees a removed one. A count the user cannot clear
          // by opening the thread reads as a broken badge.
          hiddenFor: { $ne: meId },
          retractedAt: { $exists: false },
          "removedByAdmin.at": { $exists: false },
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
        // KNOWN LIMITATION: lastMessage is denormalised onto the conversation,
        // so hiding, retracting or removing the newest message leaves its text
        // in the inbox preview until someone sends again. It matters most for
        // RETRACTION — the sender explicitly asked for it gone, and the first
        // line of their inbox still shows it. Fix is to recompute
        // convo.lastMessage in retractMessage when the retracted message is
        // the newest.
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
// pairKey (sorted participant ids) means a pair resolves to one conversation.
// On the E11000 race (two opens at once), re-fetch the winner.
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
// moves the row from Requests into Messages before the user has decided what
// to say.
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

    // The chat header needs this — deep-linking to /messages/:id doesn't load
    // the conversation list, so supply the other participant here.
    const other = convo.participants.find((p) => String(p._id) !== me);
    const otherUser = other ? other.toPublic() : null;

    // PARTICIPANT_FILTER 2 of 3 — the thread itself, and the most obvious of
    // the three to forget: without it a hidden message reappears the moment
    // the page reloads.
    const query = { conversation: id, ...visibleTo(me) };
    if (before) query.createdAt = { $lt: new Date(before) };

    const docs = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 100))
      .populate("sender");

    // The viewer decides what a removed message looks like — pass it.
    const messages = docs.reverse().map((m) => m.toClient(me));

    // Whether this user may send right now, so the input locks BEFORE they
    // type rather than after a 403. Only the initiator of a still-pending
    // thread is limited; a recipient replying accepts the conversation.
    //
    // Computed inline rather than via pendingState(), which answers
    // canSend: false for a recipient and contradicts the auto-accept above.
    //
    // DELIBERATELY unfiltered. Hiding, retracting or having your opener
    // removed must not buy you another one — the count is of what was SENT.
    // checkPendingRules counts the same way, so client and gate agree.
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
// `count` covers ACCEPTED conversations only; requestCount covers pending
// ones. The client sums them for one badge, so counting unread across all
// conversations would double-count — a pending thread with one unread message
// would contribute to each and the badge would read 2 for one waiting person.
export async function chatUnreadCount(req, res) {
  try {
    const me = currentUserId(req);

    const convos = await Conversation.find({
      participants: me,
      status: "accepted",
    }).select("_id");

    const count = await Message.countDocuments({
      conversation: { $in: convos.map((c) => c._id) },
      // readBy already contains the sender, but excluding explicitly means a
      // bug in that write cannot inflate the badge.
      sender: { $ne: me },
      readBy: { $ne: me },
      // PARTICIPANT_FILTER 3 of 3 — the one people forget. Without it the ✉
      // badge shows a count for a message the user cannot find anywhere, and
      // opening threads never clears it.
      hiddenFor: { $ne: me },
      retractedAt: { $exists: false },
      "removedByAdmin.at": { $exists: false },
    });

    // Counts CONVERSATIONS, not messages, so a request with no message yet
    // still lights the badge. openConversation creates the thread the moment
    // someone presses Message on a profile, so an abandoned tap leaves a
    // permanent empty request. Worth making creation lazy — on first send — or
    // excluding zero-message threads here.
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

    // Unfiltered on purpose: marking an invisible message read is harmless and
    // keeps readBy honest for future read receipts. The badge already excludes
    // all three cases at the count.
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
