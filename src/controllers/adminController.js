// localpulse/server/src/controllers/adminController.js
import User from "../models/User.js";
import Match from "../models/Match.js";
import Swipe from "../models/Swipe.js";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Report, { REPORT_STATUS } from "../models/Report.js";

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

// ── Reports moderation ────────────────────────────────
export async function listReports(req, res) {
  try {
    const { status } = req.query;
    const filter = status && REPORT_STATUS.includes(status) ? { status } : {};
    const reports = await Report.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("reporter")
      .populate("post")
      .populate("reportedUser");
    return res.json({
      reports: reports.map((r) => ({
        id: r._id,
        reason: r.reason,
        note: r.note,
        status: r.status,
        reporter: r.reporter?.toPublic?.(),
        post: r.post ? { id: r.post._id, text: r.post.text } : null,
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

// ── Post moderation (feed side of the hybrid app) ─────
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

// localpulse/server/src/controllers/adminController.js
//
// ⚠ PARTIAL FILE — two functions only. Do NOT paste this over
// adminController.js: it would delete stats, listUsers, setBanned, listPosts
// and deletePost. Replace the existing listReports (lines 90–116) with the one
// below, and add adminGetMessages after resolveReport.
//
// IMPORTS — add these near the existing Report / Post / Comment imports.
// Check first whether mongoose is already imported; adminGetMessages needs it
// for isValidObjectId.
//
//   import mongoose from "mongoose";
//   import Message from "../models/Message.js";
//   import Conversation from "../models/Conversation.js";

// ─────────────────────────────────────────────────────────────────────
// REPLACES the existing listReports
// ─────────────────────────────────────────────────────────────────────
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
        message: r.message
          ? {
              id: r.message._id,
              text: r.snapshotText || r.message.text || "",
              imageUrl: r.message.imageUrl || null,
              hiddenCount: (r.message.hiddenFor || []).length,
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

// ─────────────────────────────────────────────────────────────────────
// NEW — add after resolveReport
// ─────────────────────────────────────────────────────────────────────
//
// Full thread for moderation. A single reported line is usually unjudgeable —
// whether something counts as harassment depends entirely on what surrounds
// it — so the queue links here from a report.
//
// UNFILTERED on purpose. This is the one read path that must NOT apply
// `hiddenFor: { $ne: me }`. The whole point of hiding being a per-user array
// rather than a delete is that moderation still sees everything. toAdmin()
// exists for exactly this: it returns the original text plus who hid it, and
// is a separate method from toClient() so a participant-facing path cannot
// serve hidden content by passing the wrong argument.
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
