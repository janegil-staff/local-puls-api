// localpulse/server/src/controllers/chatController.js
//
// Chat controllers — SINGLE SOURCE OF TRUTH for persistence. Both web and
// mobile send via REST (POST /chat/conversations/:id/messages -> sendMessage).
// The controller saves the message, then emits it over the socket so the other
// participant gets it live.
//
// Conversation: { participants[], pairKey, status: 'pending'|'accepted',
//                 initiator, lastMessage: String, lastMessageAt }
// Message:      { conversation, sender, text?, imageUrl?, readBy[], hiddenFor[],
//                 removedByAdmin?: { by, at, reason } }
//               + toClient(viewerId) / toAdmin()
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
// document is never modified or removed. Three read paths filter, all marked
// HIDDEN_FILTER below. Miss one and a hidden message returns through a side
// door.
//
// REPORTING (reportMessage) is what makes hiding defensible. Hide-for-me is
// only safe because the record survives for moderation; a hidden message is
// still reportable by the OTHER party, who never lost their copy, and a
// reported message is untouched by anyone hiding it since hiding never
// modifies the document.
//
// ── ADMIN REMOVAL — a THIRD visibility mechanism, distinct from both ──
//
// removedByAdmin: { by, at, reason } is set by adminRemoveMessage (see
// adminController.js). Unlike hiding, it is global rather than per-user, and
// SYMMETRIC: neither participant sees the message afterwards.
//
//   sender     → the message is gone from their thread. No tombstone, no
//                marker, no gap.
//   recipient  → same.
//
// Both are filtered at the QUERY, so this is a flat exclusion in every
// participant-facing read. Sites are marked REMOVED_FILTER below.
//
// AN EARLIER VERSION OF THIS FILE WAS ASYMMETRIC — the sender kept a tombstone
// so that removal was perceptible to the person who caused it. That was
// changed deliberately. The tradeoff is real and worth stating so it is not
// re-litigated by whoever reads this next:
//
//   what symmetric removal buys   the sender cannot infer from a marker what
//                                 was removed or when, and the recipient's
//                                 thread has no shape suggesting something
//                                 was taken out of it.
//   what it costs                 a message that silently vanishes reads as a
//                                 failed send, so the likeliest next action is
//                                 that the sender types it again. Removal
//                                 teaches nothing and deters nothing on its
//                                 own; it has to be paired with banning the
//                                 account, or it is a treadmill.
//
// The second point is not a reason to revert. It is a reason that
// adminRemoveMessage should rarely be the ONLY action taken — setBanned is in
// the same controller for exactly this case.
//
// The text is NEVER blanked in the database. That is what makes restore
// return the real message instead of an empty bubble, and it is what keeps a
// removed message meaningful in the moderation queue.
//
// toClient(viewerId) still takes a viewer, and Message.js may still contain a
// tombstone branch for a removed message. NOTHING IN THIS FILE REACHES IT any
// more — every participant read excludes removed messages before serialisation
// — so that branch is dead code from the participant surface. Left in place
// rather than stripped, because reinstating the tombstone is a one-line change
// to the getMessages query while re-deriving the serializer is not.
//
// COUNTING is deliberately unfiltered by removal, in both places it happens:
// the pending-request gate here and checkPendingRules in pendingGuard.js. If
// an admin removed your one opening message, that must not hand you a fresh
// one — the count is of what was SENT. This matters MORE under symmetric
// removal, not less: the sender cannot see that their message is gone, so
// without this they would find themselves able to send into a stranger's
// thread repeatedly with no idea why.
//
// KNOWN LEAK — Conversation.lastMessage. The inbox row preview is
// denormalised onto the conversation by persistMessage and is not recomputed
// here; adminRemoveMessage calls recomputeConversationPreview for that. Under
// symmetric removal this applies to BOTH participants — a stale preview would
// show the removed text to the sender and the recipient alike.

import mongoose from "mongoose";
import Conversation, { buildPairKey } from "../models/Conversation.js";
import Message from "../models/Message.js";
import Report, { REPORT_REASONS } from "../models/Report.js";
import { checkPendingRules } from "../lib/pendingGuard.js";

function currentUserId(req) {
  return String(req.user.id || req.user.sub);
}

// Query fragment for every participant-facing read. Flat exclusion — removal
// is symmetric, so no read here ever returns a removed message to anyone.
//
// Tests "removedByAdmin.at" rather than "removedByAdmin" because a Mongoose
// subdocument path may be stored as an empty object rather than omitted
// entirely — { removedByAdmin: { $exists: false } } would then match nothing
// and every message in every thread would vanish for everyone. The dotted path
// is true in both storage shapes.
//
// Written out at each site rather than shared through a helper, because there
// are only three and a helper here previously encoded the sender exception
// that symmetric removal removed. A constant that no longer means what its
// name says is worse than three literal filters.
const REMOVED_EXCLUSION = { "removedByAdmin.at": { $exists: false } };

// The same idea for retraction — the sender withdrawing their own message,
// gone for BOTH participants. A third visibility mechanism alongside
// hiddenFor and removedByAdmin, and it needs the same treatment at every
// participant-facing read: sites are marked RETRACTED_FILTER below.
//
// Plain path, not a dotted one: retractedAt is a top-level Date, so
// { $exists: false } is true exactly when the message has not been
// retracted. No empty-subdocument trap like removedByAdmin has.
const RETRACTED_EXCLUSION = { retractedAt: { $exists: false } };

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

  // A just-created message can never be removed, so the viewer argument is
  // immaterial here — but it is passed anyway so that every toClient call site
  // in this file has one. A call with no viewer is the shape that silently
  // leaks a removed message's text, and the way to never write one is to never
  // leave an example of one lying around.
  const payload = message.toClient(senderId);

  // Broadcast live to anyone in the conversation room + notify the other side.
  //
  // ONE payload to the whole room, which is only safe because the message is
  // new. Do NOT copy this shape for removal/restore events: those need a
  // per-participant payload, since the sender gets a tombstone and the
  // recipient gets a deletion. adminController emits per-user for that reason.
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

// Shared membership check for the per-message actions below. Returns the
// message document, or { status, error } to respond with.
//
// The 404-before-403 order is deliberate: a non-participant gets 403 for a
// message that exists and 404 for one that does not, which leaks existence.
// Both branches return before revealing any content, and the ids are random
// ObjectIds, so the leak is not worth an extra query to close.
//
// NOT filtered by removedByAdmin, and the select now pulls it so callers can
// decide for themselves. A recipient cannot normally reach a removed message
// — it is absent from their thread — but a stale id from before the removal
// could still arrive here, and neither action it feeds is harmful on one:
// hiding is a no-op on something already invisible, and reporting something a
// moderator has already acted on costs a queue row, not a leak. The 404 that
// a filter here would produce is strictly worse: it would tell the recipient
// that the message existed and then stopped existing.
async function findMessageForParticipant(messageId, userId) {
  if (!mongoose.isValidObjectId(messageId)) {
    return { status: 400, error: "Invalid message id" };
  }

  const msg = await Message.findById(messageId).select(
    "_id conversation sender text imageUrl removedByAdmin retractedAt",
  );
  if (!msg) return { status: 404, error: "Message not found" };

  const convo = await Conversation.findOne({
    _id: msg.conversation,
    participants: userId,
  }).select("_id");
  if (!convo) return { status: 403, error: "Not a participant" };

  return { msg };
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
//
// Hiding your own tombstone is allowed and works: hiddenFor is checked before
// the removal filter in every read, so a sender who does not want to look at
// the marker can put it away. Restore will not bring it back for them, which
// is correct — that is their own hide, not the admin's removal.
export async function hideMessage(req, res) {
  try {
    const me = currentUserId(req);
    const found = await findMessageForParticipant(req.params.id, me);
    if (found.error)
      return res.status(found.status).json({ error: found.error });

    const r = await Message.updateOne(
      { _id: found.msg._id },
      { $addToSet: { hiddenFor: me } },
    );
    console.log("[hideMessage]", String(found.msg._id), me, r.modifiedCount);

    return res.json({ ok: true, messageId: String(found.msg._id) });
  } catch (err) {
    console.error("[hideMessage] failed:", err);
    return res.status(500).json({ error: "Failed to hide message" });
  }
}

// ── Report a single message ───────────────────────────────────────────
//
// This is the counterweight to hiding. Hide-for-me is only defensible because
// the record survives — so the report path must exist, must reach the same
// moderation queue as post and user reports, and must not be defeatable by
// the reported party (who cannot touch the other side's copy at all).
//
// The report captures snapshotText and conversation alongside the message id:
// a moderator needs the text as it was reported, and needs the thread around
// it, because one line lifted out of a conversation is usually unjudgeable.
//
// snapshotText survives admin removal for the same reason restore does: the
// text is never blanked in the database. A report filed before a removal, and
// the removal itself, therefore do not fight over the same field.
//
// reportedUser is set to the sender so the queue's group-by-user view picks
// message reports up without any change to its existing queries.
//
// Filing twice is a no-op returning 200, not a 409. A duplicate report is a
// user pressing a button twice, not an error state worth surfacing — and the
// unique sparse index on { reporter, message } makes that true even under a
// race.
//
// NOT filtered by hiddenFor: you can report a message you have hidden. The
// two actions are independent, and someone who hides something abusive and
// then decides to report it must not find the option gone.
export async function reportMessage(req, res) {
  try {
    const me = currentUserId(req);
    const { reason, note } = req.body || {};

    // Validated here rather than in the route's validate() middleware, whose
    // schema DSL has no enum support — an unknown reason would otherwise
    // reach Mongoose and surface as a 500 rather than a 400.
    if (!REPORT_REASONS.includes(reason)) {
      return res.status(400).json({ error: "Invalid reason" });
    }

    const found = await findMessageForParticipant(req.params.id, me);
    if (found.error)
      return res.status(found.status).json({ error: found.error });

    const msg = found.msg;

    // Reporting your own message is meaningless and would put a moderator's
    // time on a complaint with no counterparty. This also means a sender
    // cannot report their own tombstone, which is the right outcome — the
    // route for disputing a removal is an appeal, not the abuse queue.
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
    // The unique index firing means two requests raced. That is still a
    // success from the user's point of view.
    if (err?.code === 11000) {
      return res.json({ ok: true, duplicate: true });
    }
    console.error("[reportMessage] failed:", err);
    return res.status(500).json({ error: "Failed to report message" });
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
          // REMOVED_FILTER 1 of 3 — flat exclusion, like all three. Removal is
          // symmetric, so nothing removed is ever counted for anyone. Same
          // failure mode as the hidden case if omitted — a count for a message
          // that is not in the thread.
          "removedByAdmin.at": { $exists: false },
          // RETRACTED_FILTER 2 of 3 — the per-conversation unread count. A
          // retracted message is not in the thread, so a count including it
          // can never be cleared by opening the conversation.
          retractedAt: { $exists: false },
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
        //
        // ADMIN REMOVAL MAKES THIS WORSE, and not tolerably so. The recipient
        // is supposed to lose the content entirely, and this row hands it back
        // to them. Unlike the hiding case it cannot be waved off as cosmetic.
        // Fix belongs in adminRemoveMessage — recompute lastMessage from the
        // newest non-removed message — NOT here, where it would cost a second
        // aggregate on every inbox load to paper over a write-time omission.
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
        // Same lastMessage caveat as listConversations, and it bites harder
        // here: a request row IS the removed message, since a pending thread
        // usually holds exactly one. Recomputing on removal leaves this row
        // showing an empty preview, which is the correct outcome — the thread
        // has nothing in it the recipient may see.
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

    // Only a NEWLY created pending thread notifies the recipient. Re-opening
    // an existing conversation must not fire anything.
    let created = false;

    if (!convo) {
      try {
        convo = await Conversation.create({
          participants: [me, userId],
          pairKey,
          initiator: me,
          status: "pending",
        });
        created = true;
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

    // REQUEST_NOTIFY — a request with no message still changes the
    // recipient's requestCount, and nothing else emits for it. persistMessage
    // fires chat:notify only when someone actually sends, so without this the
    // badge does not move until the app next cold-starts and primes.
    //
    // chat:notify rather than a new event name: both clients already bind it
    // and call refreshUnread, so this needs no client change.
    if (created && convo.status === "pending") {
      const io = req.app.get("io");
      if (io) {
        io.to(`user:${userId}`).emit("chat:notify", {
          conversationId: String(convo._id),
        });
      }
    }

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
    //
    // REMOVED_FILTER 2 of 3 — flat, like the other two. This is the ONE read
    // that returns the viewer's own messages, so it is the only place where
    // the sender-exception used to live; under symmetric removal there is no
    // exception and the sender loses their own message here exactly as the
    // recipient does.
    //
    // THIS LINE IS THE WHOLE BEHAVIOUR. Reinstating the tombstone means
    // changing this one filter back to an $or on { sender: me } and nothing
    // else — the serializer in Message.js can still render it.
    const query = {
      conversation: id,
      hiddenFor: { $ne: me },
      ...REMOVED_EXCLUSION,
      // RETRACTED_FILTER 1 of 3 — the thread. Without this a retracted
      // message disappears live over the socket and comes straight back on
      // reload, which reads as the feature not working at all.
      ...RETRACTED_EXCLUSION,
    };
    if (before) query.createdAt = { $lt: new Date(before) };

    const docs = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 100))
      .populate("sender");

    // toClient(me) — the viewer argument no longer changes the output for
    // removed messages, because none reach here. Kept because Message.js takes
    // it and because it is the hook the tombstone would hang from again.
    const messages = docs.reverse().map((m) => m.toClient(me));

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
    //
    // DELIBERATELY NOT filtered by removedByAdmin either, and for a stronger
    // reason. Excluding removed messages here would mean that having your
    // opening message removed for abuse resets your one-message allowance and
    // lets you send into the same stranger's thread again. checkPendingRules
    // counts unfiltered too; if either side ever starts filtering, the client
    // will offer a send the server then rejects, or worse, the server will
    // allow one the client never showed.
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
      // REMOVED_FILTER 3 of 3 — flat exclusion again, for the same reason as
      // the aggregate: sender: { $ne: me } means nothing counted here is ever
      // mine. This one is worse than the hidden case when missed, because an
      // admin removal is not something the user did — they get a permanent
      // badge for a message they never saw and cannot act on.
      "removedByAdmin.at": { $exists: false },
      // RETRACTED_FILTER 3 of 3 — the ✉ badge. Same failure as the other
      // two: a permanent count for a message that is nowhere to be found.
      retractedAt: { $exists: false },
    });

    // Incoming requests awaiting this user's approval.
    //
    // Counts CONVERSATIONS, not messages, so a request with no message yet
    // still lights the badge. openConversation creates the thread the moment
    // someone presses Message on a profile, which means an abandoned tap
    // leaves a permanent empty request in the recipient's list. Worth making
    // creation lazy — on first send — or excluding zero-message threads here.
    //
    // A request whose only message was removed is now one of those empty
    // threads, and it still counts. That is arguably right: the recipient is
    // still being asked to accept or decline a stranger. Revisit alongside the
    // lazy-creation change, not before — they are the same fix.
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
    //
    // Not filtered by removedByAdmin either, on the same reasoning — this is a
    // WRITE to readBy, not a read of content, and every count that feeds a
    // badge already excludes removed messages. Adding a filter here would also
    // leave a removed-then-restored message permanently unread for a recipient
    // who had the thread open the whole time, which is a worse outcome than a
    // readBy entry nobody looks at.
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

// ── Unhide a message I previously hid ─────────────────────────────────
//
// The mirror of hideMessage: $pull instead of $addToSet. No time limit —
// hiding never affected the other party, so restoring my own view cannot
// surprise anyone.
//
// The comment on hideMessage says there is no unhide endpoint "because a UI
// listing what you have hidden would be needed to reach it". That is no longer
// true: the web client shows an undo toast on hide, and undo calls this. Until
// now that toast offered a reversal that 404'd.
//
// Idempotent. Unhiding something not hidden is a no-op 200, matching how
// duplicate reports are handled.
//
// No socket broadcast, for the same reason hideMessage has none: the change
// affects exactly one viewer, and telling the other participant anything would
// leak that you had hidden their message.
export async function unhideMessage(req, res) {
  try {
    const me = currentUserId(req);
    const found = await findMessageForParticipant(req.params.id, me);
    if (found.error)
      return res.status(found.status).json({ error: found.error });

    const r = await Message.updateOne(
      { _id: found.msg._id },
      { $pull: { hiddenFor: me } },
    );
    console.log("[unhideMessage]", String(found.msg._id), me, r.modifiedCount);

    return res.json({ ok: true, messageId: String(found.msg._id) });
  } catch (err) {
    console.error("[unhideMessage] failed:", err);
    return res.status(500).json({ error: "Failed to unhide message" });
  }
}

// ── Retract my own message — gone for BOTH participants ───────────────
//
// The third visibility mechanism after hiddenFor and removedByAdmin, and the
// only one the sender controls. The three RETRACTED_FILTER sites above are
// what make it real; this handler only sets the flag.
//
// The text is NEVER blanked, for the same reason removal does not blank it: a
// report filed before a retraction keeps its subject, and a moderator reading
// the thread needs the real message.
//
// IRREVERSIBLE, by decision. There is no unretractMessage and adding one would
// be a mistake:
//
//   - the confirm dialog tells the sender before they act ("Dette kan ikke
//     angres"), so undo would make shipped copy false in the other direction
//   - un-retract lets someone remove and restore a message around a
//     moderator's review of it, so the queue and the thread disagree about
//     what was ever said
//
// Refuses once reported. Without this, reporting is defeatable by the reported
// party: report arrives, sender retracts, the moderator opens a thread with a
// hole in it. Report.snapshotText survives, but the surrounding thread is half
// the evidence — reportMessage's own comment makes that point.
export async function retractMessage(req, res) {
  try {
    const me = currentUserId(req);
    const found = await findMessageForParticipant(req.params.id, me);
    if (found.error)
      return res.status(found.status).json({ error: found.error });

    const msg = found.msg;

    // Participation is not enough — retraction is the SENDER withdrawing their
    // own words. Acting on the other party's message is what hide is for.
    if (String(msg.sender) !== me) {
      return res.status(403).json({
        error: "You can only retract your own messages",
        code: "not_sender",
      });
    }

    // Already retracted: no-op 200. A double click or a second device must not
    // produce a failure. Works because findMessageForParticipant now selects
    // retractedAt — it did not before this patch.
    if (msg.retractedAt) {
      return res.json({
        ok: true,
        alreadyRetracted: true,
        messageId: String(msg._id),
      });
    }

    const reported = await Report.exists({ message: msg._id });
    if (reported) {
      return res.status(409).json({
        error: "This message has been reported and cannot be retracted",
        code: "message_reported",
      });
    }

    await Message.updateOne(
      { _id: msg._id },
      { $set: { retractedAt: new Date() } },
    );

    // Both participants are in the conversation room, so one emit reaches the
    // recipient and the sender's other devices. Unlike removal, retraction is
    // symmetric and carries no per-participant difference, so a single room
    // payload is correct here — see the warning on persistMessage's emit.
    const io = req.app.get("io");
    if (io) {
      io.to(`conversation:${msg.conversation}`).emit("chat:message:retracted", {
        conversationId: String(msg.conversation),
        messageId: String(msg._id),
      });
    }

    console.log("[retractMessage]", String(msg._id), me);
    return res.json({ ok: true, messageId: String(msg._id) });
  } catch (err) {
    console.error("[retractMessage] failed:", err);
    return res.status(500).json({ error: "Failed to retract message" });
  }
}
