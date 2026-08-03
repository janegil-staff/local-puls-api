// localpulse/server/src/controllers/adminController.js
//
// Admin/moderation controllers. Every export here is mounted behind
// requireAdmin in admin.routes.js — there is no per-user authorisation inside
// these functions, so a route added without that middleware is a full breach,
// not a bug.
//
// Message moderation lives in the back half of this file:
//   adminGetMessages          — full thread, UNFILTERED, reached from a report
//   adminListHiddenMessages   — messages a participant hid from their own view
//   adminRemoveMessage        — sets removedByAdmin (asymmetric, reversible)
//   adminRestoreMessage       — unsets it
//
// See chatController.js for the read side: what removal does to each
// participant's view, and the three filter sites that enforce it.

import User from "../models/User.js";
import Match from "../models/Match.js";
import Swipe from "../models/Swipe.js";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Report, { REPORT_STATUS } from "../models/Report.js";
import mongoose from "mongoose";
import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";

// The acting admin's id, for the removedByAdmin audit trail.
//
// Defined here rather than imported from chatController.js on purpose: that
// module is the participant-facing controller and this one is not, and a
// cross-import between them is the kind of edge that turns into a cycle the
// first time either file grows a helper the other wants.
//
// The previous version of adminRemoveMessage CALLED this without defining it
// anywhere in this file, so it threw a ReferenceError on its first line and
// the catch reported "Could not remove message" — a 500 that looked like a
// database problem and was not.
function currentUserId(req) {
  return String(req.user.id || req.user.sub);
}

// Recompute a conversation's denormalised preview after a removal or restore.
//
// WHY THIS EXISTS: Conversation.lastMessage is written at send time by
// persistMessage. Nothing else updates it. Without this call, an admin removes
// a message and the recipient — who can no longer open it, because
// chatController filters it out of their thread — still reads its full text as
// the preview on their inbox row, indefinitely, until someone sends again.
// Removing content from the thread and leaving it on the list that links to
// the thread is not a partial fix; it is the same exposure through a shorter
// path.
//
// Deliberately only aware of removal, NOT of hiddenFor. lastMessage is a
// single shared field on the conversation and hiding is per-user, so the two
// cannot both be honoured in one string. Hiding tolerates the staleness
// because the other participant never lost anything; removal does not.
//
// Empty conversation → empty preview and lastMessageAt pinned to the
// conversation's own createdAt, so the row sorts to the bottom of the inbox
// rather than vanishing from a { lastMessageAt: -1 } sort on a null.
async function recomputeConversationPreview(conversationId) {
  const convo = await Conversation.findById(conversationId);
  if (!convo) return;

  const newest = await Message.findOne({
    conversation: conversationId,
    "removedByAdmin.at": { $exists: false },
  })
    .sort({ createdAt: -1 })
    .select("text imageUrl createdAt");

  if (newest) {
    convo.lastMessage = newest.text ? newest.text : "📷";
    convo.lastMessageAt = newest.createdAt;
  } else {
    convo.lastMessage = "";
    convo.lastMessageAt = convo.createdAt;
  }

  await convo.save();
}

// Dashboard counters for the admin analytics view.
export async function stats(_req, res) {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [
      users,
      matches,
      swipes,
      posts,
      bannedUsers,
      newUsers,
      openReports,
      completeProfiles,
    ] = await Promise.all([
      User.countDocuments(),
      Match.countDocuments({ active: true }),
      Swipe.countDocuments(),
      Post.countDocuments(),
      User.countDocuments({ banned: true }),
      User.countDocuments({ createdAt: { $gte: since } }),
      Report.countDocuments({ status: "open" }),
      User.countDocuments({ profileComplete: true }),
    ]);

    // Swipes split by action — a small bar chart in the admin.
    const byAction = await Swipe.aggregate([
      { $group: { _id: "$action", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    return res.json({
      totals: {
        users,
        matches,
        swipes,
        posts,
        completeProfiles,
        bannedUsers,
        openReports,
        newUsersLast7d: newUsers,
      },
      swipesByAction: byAction.map((t) => ({ action: t._id, count: t.count })),
    });
  } catch (err) {
    console.error("admin stats error", err);
    return res.status(500).json({ error: "Could not load stats" });
  }
}

// NOTE: `q` goes straight into RegExp uninterpreted, so an admin can enter a
// pattern that backtracks badly and stall the request. Admin-only and
// unchanged from the original — flagged, not fixed, because escaping it would
// silently remove regex search from anyone currently relying on it. Escape at
// the same time you decide nobody is.
export async function listUsers(req, res) {
  try {
    const { q, limit } = req.query;
    const lim = Math.min(Number(limit) || 50, 100);
    const filter = q
      ? {
          $or: [
            { username: new RegExp(q, "i") },
            { email: new RegExp(q, "i") },
          ],
        }
      : {};
    const users = await User.find(filter).sort({ createdAt: -1 }).limit(lim);
    return res.json({
      users: users.map((u) => ({
        ...u.toPublic(),
        email: u.email,
        role: u.role,
        banned: u.banned,
        createdAt: u.createdAt,
      })),
    });
  } catch (err) {
    console.error("listUsers error", err);
    return res.status(500).json({ error: "Could not list users" });
  }
}

export async function setBanned(req, res) {
  try {
    const { banned } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { banned: Boolean(banned) },
      { new: true },
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({ id: user._id, banned: user.banned });
  } catch (err) {
    console.error("setBanned error", err);
    return res.status(500).json({ error: "Could not update user" });
  }
}

// ── Report queue ──────────────────────────────────────────────────────
//
// Message reports carry `message` + `conversation` + `snapshotText`; post
// reports carry `post`; a bare user report carries neither. All three land in
// the same queue, so the client branches on which field is non-null.
//
// A message report ALSO sets reportedUser (the sender), which is why any
// existing group-by-user view picks these up with no change.
export async function listReports(req, res) {
  try {
    const { status } = req.query;
    const filter = status && REPORT_STATUS.includes(status) ? { status } : {};
    const reports = await Report.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("reporter")
      .populate("post")
      .populate("message")
      .populate("reportedUser");
    return res.json({
      reports: reports.map((r) => ({
        id: r._id,
        reason: r.reason,
        note: r.note,
        status: r.status,
        reporter: r.reporter?.toPublic?.(),
        post: r.post ? { id: r.post._id, text: r.post.text } : null,
        // snapshotText FIRST, live text as fallback. The snapshot is the text
        // as it was when reported, which is the thing being judged — reading
        // the live document instead would make the report meaningless the day
        // message editing lands.
        //
        // hiddenCount is context, not evidence: it says a participant hid this
        // from their own view, which is neither an admission nor a defence.
        // The message itself is untouched by hiding, which is why it is still
        // here to read at all.
        //
        // removed tells the moderator this queue row has already been acted
        // on, so two moderators working the queue do not both remove it and
        // the second does not read the absence of an effect as a broken
        // button. adminRemoveMessage is idempotent regardless.
        message: r.message
          ? {
              id: r.message._id,
              text: r.snapshotText || r.message.text || "",
              imageUrl: r.message.imageUrl || null,
              hiddenCount: (r.message.hiddenFor || []).length,
              removed: Boolean(r.message.removedByAdmin?.at),
              removedAt: r.message.removedByAdmin?.at || null,
              createdAt: r.message.createdAt,
            }
          : null,
        // Not populated — only the id is needed, to link into the thread view.
        conversationId: r.conversation ? String(r.conversation) : null,
        reportedUser: r.reportedUser?.toPublic?.() || null,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error("listReports error", err);
    return res.status(500).json({ error: "Could not load reports" });
  }
}

export async function resolveReport(req, res) {
  try {
    const { status } = req.body;
    if (!REPORT_STATUS.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const report = await Report.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true },
    );
    if (!report) return res.status(404).json({ error: "Report not found" });
    return res.json({ id: report._id, status: report.status });
  } catch (err) {
    console.error("resolveReport error", err);
    return res.status(500).json({ error: "Could not update report" });
  }
}

// ── Post moderation (feed side of the hybrid app) ─────────────────────
export async function listPosts(req, res) {
  try {
    const lim = Math.min(Number(req.query.limit) || 50, 100);
    const posts = await Post.find()
      .sort({ createdAt: -1 })
      .limit(lim)
      .populate("author");
    return res.json({
      posts: posts.map((p) => ({
        ...p.toClient(),
        author: p.author?.toPublic?.(),
      })),
    });
  } catch (err) {
    console.error("admin listPosts error", err);
    return res.status(500).json({ error: "Could not list posts" });
  }
}

export async function deletePost(req, res) {
  try {
    const post = await Post.findByIdAndDelete(req.params.id);
    if (!post) return res.status(404).json({ error: "Post not found" });
    await Comment.deleteMany({ post: post._id });
    return res.json({ ok: true });
  } catch (err) {
    console.error("admin deletePost error", err);
    return res.status(500).json({ error: "Could not delete post" });
  }
}

// ── Full thread for moderation ────────────────────────────────────────
//
// A single reported line is usually unjudgeable — whether something counts as
// harassment depends entirely on what surrounds it — so the queue links here
// from a report.
//
// UNFILTERED on purpose, on both axes. It does not apply hiddenFor, because
// the whole point of hiding being a per-user array rather than a delete is
// that moderation still sees everything. It does not apply the removal filter
// either, which is what makes restore reachable: a moderator viewing the
// thread sees removed messages in place, marked, and can put one back.
//
// toAdmin() exists for exactly this. It is a SEPARATE method from
// toClient(viewerId) so that a participant-facing path cannot serve moderation
// content by passing the wrong argument — the two cannot be confused at a call
// site because they do not share a signature.
//
// No participant check — requireAdmin is the only gate. That makes this a
// privileged read of a private conversation, so it should only ever be
// reached FROM A REPORT. Linked from a user detail page or a search box, it
// stops being a moderation tool and becomes a general-purpose DM viewer for
// anyone holding the admin flag.
export async function adminGetMessages(req, res) {
  try {
    const { id } = req.params;
    const lim = Math.min(Number(req.query.limit) || 200, 500);

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid conversation id" });
    }

    const convo = await Conversation.findById(id).populate("participants");
    if (!convo)
      return res.status(404).json({ error: "Conversation not found" });

    const docs = await Message.find({ conversation: id })
      .sort({ createdAt: -1 })
      .limit(lim)
      .populate("sender");

    return res.json({
      conversation: {
        id: String(convo._id),
        status: convo.status,
        initiator: String(convo.initiator),
        participants: (convo.participants || []).map(
          (p) => p.toPublic?.() || null,
        ),
      },
      messages: docs.reverse().map((m) => m.toAdmin()),
    });
  } catch (err) {
    console.error("adminGetMessages error", err);
    return res.status(500).json({ error: "Could not load conversation" });
  }
}

// ── Messages hidden by a participant ──────────────────────────────────
//
// "Deleted messages" in the admin UI. Hiding sets hiddenFor; it never modifies
// or removes the document, so the original text is returned intact.
//
// `hiddenFor.0` existing is the cheapest non-empty-array test Mongo offers and
// uses the { conversation, hiddenFor } index. $size: { $gt: 0 } is not valid
// and $expr would force a collection scan.
//
// hiddenByUsers is populated because WHO hid it is the only part with any
// interpretive value — a recipient hiding something they were sent reads very
// differently from a sender tidying up after themselves. Neither is evidence
// of anything on its own; most hiding is ordinary housekeeping.
//
// POPULATE REQUIREMENT: .populate("hiddenFor") throws unless hiddenFor is
// declared in Message.js as [{ type: ObjectId, ref: "User" }]. A bare
// [ObjectId] array with no ref is a 500 on this endpoint and nowhere else,
// because nothing else populates it.
//
// No report anchors these reads, unlike adminGetMessages. If that ever becomes
// uncomfortable, the honest fix is to drop the page rather than to soften it.
export async function adminListHiddenMessages(req, res) {
  try {
    const lim = Math.min(Number(req.query.limit) || 100, 200);

    const docs = await Message.find({ "hiddenFor.0": { $exists: true } })
      .sort({ createdAt: -1 })
      .limit(lim)
      .populate("sender")
      .populate("hiddenFor");

    return res.json({
      messages: docs.map((m) => ({
        id: String(m._id),
        conversationId: String(m.conversation),
        sender: m.sender?.toPublic?.() || null,
        text: m.text || "",
        ...(m.imageUrl ? { imageUrl: m.imageUrl } : {}),
        hiddenCount: (m.hiddenFor || []).length,
        hiddenByUsers: (m.hiddenFor || [])
          .map((u) => u?.toPublic?.() || null)
          .filter(Boolean),
        // Removal state, so the row can render Remove or Restore rather than
        // Remove always. Hiding and removal are independent — a message can be
        // both — and a page that shows only one of them will offer an action
        // that has already been taken.
        removed: Boolean(m.removedByAdmin?.at),
        removedAt: m.removedByAdmin?.at || null,
        removedReason: m.removedByAdmin?.reason || "",
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    console.error("adminListHiddenMessages error", err);
    return res.status(500).json({ error: "Could not load hidden messages" });
  }
}

// ── Messages removed by a moderator ───────────────────────────────────
//
// The list that makes removal reversible in practice. adminRestoreMessage has
// existed since the first partial, but nothing could route to it: removed
// messages appear in adminListHiddenMessages only if a participant ALSO hid
// them, and in adminGetMessages only if a report happens to point at that
// conversation. Remove a message outside both cases and it is unreachable —
// the moderator cannot undo their own action, which quietly turns a reversible
// tool into a permanent one.
//
// Text is returned in full because it is preserved in the database; that is
// the same property restore depends on. A moderator deciding whether to put a
// message back has to be able to read it.
//
// UNANCHORED, like adminListHiddenMessages — no report gates it. The
// justification is narrower and better here: every row is content this team
// already acted on, not private conversation surfaced on a hunch. If the
// hidden-messages page is ever dropped for that reason, this one survives it.
//
// `removedByAdmin.at` existing is the presence test every other query in the
// system uses, so this list can never disagree with what participants see.
// It wants an index — { "removedByAdmin.at": -1 } — or this sorts in memory
// across the whole messages collection.
//
// The removing admin is resolved with a second query rather than
// .populate("removedByAdmin.by"). Populate on a subdocument path throws if the
// schema declares it without a ref, and that failure mode has already cost two
// rounds on this feature. A manual lookup does not care how the field is
// declared.
export async function adminListRemovedMessages(req, res) {
  try {
    const lim = Math.min(Number(req.query.limit) || 100, 200);

    const docs = await Message.find({ "removedByAdmin.at": { $exists: true } })
      .sort({ "removedByAdmin.at": -1 })
      .limit(lim)
      .populate("sender");

    // One query for every distinct moderator in the page, not one per row.
    const adminIds = [
      ...new Set(
        docs
          .map((m) => m.removedByAdmin?.by)
          .filter(Boolean)
          .map((v) => String(v)),
      ),
    ];
    const admins = adminIds.length
      ? await User.find({ _id: { $in: adminIds } })
      : [];
    const adminById = new Map(admins.map((u) => [String(u._id), u]));

    return res.json({
      messages: docs.map((m) => {
        const byId = m.removedByAdmin?.by ? String(m.removedByAdmin.by) : null;
        return {
          id: String(m._id),
          conversationId: String(m.conversation),
          sender: m.sender?.toPublic?.() || null,
          text: m.text || "",
          ...(m.imageUrl ? { imageUrl: m.imageUrl } : {}),
          removedAt: m.removedByAdmin?.at || null,
          removedReason: m.removedByAdmin?.reason || "",
          // null when the removing admin's account has since been deleted.
          // The removal still stands; only the attribution is gone.
          removedBy: byId ? adminById.get(byId)?.toPublic?.() || null : null,
          // Hiding and removal are independent, and a message can be both.
          // Shown so a moderator restoring something understands that a
          // participant may still not see it afterwards — their own hide
          // survives the restore, which is correct but surprising.
          hiddenCount: (m.hiddenFor || []).length,
          createdAt: m.createdAt,
        };
      }),
    });
  } catch (err) {
    console.error("adminListRemovedMessages error", err);
    return res.status(500).json({ error: "Could not load removed messages" });
  }
}

// ── Remove a message (moderator) ──────────────────────────────────────
//
// Sets removedByAdmin; the document and its text are untouched, so a restore
// returns the real message rather than an empty bubble, and a report about it
// stays actionable.
//
// SYMMETRIC. Neither participant sees the message afterwards — no tombstone
// for the sender, no placeholder for the recipient. Both threads simply do not
// contain it, because chatController excludes it at the query for everyone.
//
// The cost of that symmetry is worth knowing before you use this button: the
// sender cannot perceive the removal, so it reads to them as a message that
// failed to send, and the likeliest next thing they do is type it again.
// Removal on its own teaches nothing and deters nothing.
//
// Which is why this is the WEAKEST tool here, and more so under symmetric
// removal than it was before. If a message was bad enough to remove, the live
// question is almost always whether the account should still be sending
// messages at all — setBanned is above this in the same controller, and
// removal without it is usually just the first move in a loop.
//
// Reversible on purpose. Moderators act on incomplete information and reports
// are sometimes wrong; a one-way action makes a mistake permanent.
export async function adminRemoveMessage(req, res) {
  try {
    const me = currentUserId(req);
    const { id } = req.params;
    const { reason } = req.body || {};

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid message id" });
    }

    const msg = await Message.findById(id).select(
      "_id conversation sender removedByAdmin",
    );
    if (!msg) return res.status(404).json({ error: "Message not found" });

    // Idempotent. Two moderators working the same queue row must not produce
    // an error on the second click, and must not overwrite the first one's
    // name and timestamp in the audit trail.
    if (msg.removedByAdmin?.at) {
      return res.json({
        ok: true,
        alreadyRemoved: true,
        messageId: String(msg._id),
      });
    }

    await Message.updateOne(
      { _id: msg._id },
      {
        $set: {
          "removedByAdmin.by": me,
          "removedByAdmin.at": new Date(),
          "removedByAdmin.reason":
            typeof reason === "string" ? reason.slice(0, 500) : "",
        },
      },
    );

    // MUST run after the $set and before the socket emit. See the helper for
    // why: without it the recipient keeps reading the removed text as their
    // inbox preview even though the thread no longer contains it.
    await recomputeConversationPreview(msg.conversation);

    const io = req.app.get("io");
    if (io) {
      // Open threads. senderId is still in the payload even though both
      // clients now do the same thing with this event — drop the message —
      // because it is the only field that would let a client branch again if
      // the tombstone is ever reinstated, and removing it costs nothing to
      // keep.
      io.to(`conversation:${msg.conversation}`).emit("chat:message:removed", {
        conversationId: String(msg.conversation),
        messageId: String(msg._id),
        senderId: String(msg.sender),
      });

      // Inbox rows and the ✉ badge, for participants who are NOT sitting in
      // the conversation room. Without this the recipient's unread count still
      // includes the removed message until they navigate, which reads as a
      // badge that will not clear — the exact failure the REMOVED_FILTER sites
      // in chatController exist to prevent, reintroduced by a stale client.
      const convo = await Conversation.findById(msg.conversation).select(
        "participants",
      );
      (convo?.participants || []).forEach((p) =>
        io.to(`user:${String(p)}`).emit("chat:notify", {
          conversationId: String(msg.conversation),
        }),
      );
    }

    return res.json({ ok: true, messageId: String(msg._id) });
  } catch (err) {
    console.error("adminRemoveMessage error", err);
    return res.status(500).json({ error: "Could not remove message" });
  }
}

// ── Restore a removed message ─────────────────────────────────────────
//
// $unset rather than setting a flag back to false, so the absence of
// removedByAdmin.at stays the single presence test every query relies on.
//
// This also discards who removed it and why. That is a real loss for an audit
// trail — a moderator cannot later see that this message was removed and put
// back — and the fix is a separate moderationLog collection rather than
// keeping a tombstoned field here, because a field that must be absent for the
// queries to work cannot also be a history.
//
// The recipient does NOT get the message back in place silently in an open
// tab; the socket event tells their client to refetch. Without it they would
// keep a thread missing a message that exists again.
export async function adminRestoreMessage(req, res) {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid message id" });
    }

    const msg = await Message.findById(id).select(
      "_id conversation sender removedByAdmin",
    );
    if (!msg) return res.status(404).json({ error: "Message not found" });

    if (!msg.removedByAdmin?.at) {
      return res.json({
        ok: true,
        alreadyRestored: true,
        messageId: String(msg._id),
      });
    }

    await Message.updateOne(
      { _id: msg._id },
      { $unset: { removedByAdmin: "" } },
    );

    // Symmetric with removal: the restored message may be the newest one
    // again, in which case the preview has to come back too. Skipping this
    // leaves the inbox row showing an older message than the thread does.
    await recomputeConversationPreview(msg.conversation);

    const io = req.app.get("io");
    if (io) {
      io.to(`conversation:${msg.conversation}`).emit("chat:message:restored", {
        conversationId: String(msg.conversation),
        messageId: String(msg._id),
      });

      const convo = await Conversation.findById(msg.conversation).select(
        "participants",
      );
      (convo?.participants || []).forEach((p) =>
        io.to(`user:${String(p)}`).emit("chat:notify", {
          conversationId: String(msg.conversation),
        }),
      );
    }

    return res.json({ ok: true, messageId: String(msg._id) });
  } catch (err) {
    console.error("adminRestoreMessage error", err);
    return res.status(500).json({ error: "Could not restore message" });
  }
}
