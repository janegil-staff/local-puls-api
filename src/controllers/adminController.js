// localpulse/server/src/controllers/adminController.js
import User from '../models/User.js';
import Post from '../models/Post.js';
import Comment from '../models/Comment.js';
import Report, { REPORT_STATUS } from '../models/Report.js';

// Dashboard counters for the admin analytics view.
export async function stats(_req, res) {
  try {
    const [users, posts, comments, bannedUsers] = await Promise.all([
      User.countDocuments(),
      Post.countDocuments(),
      Comment.countDocuments(),
      User.countDocuments({ banned: true }),
    ]);

    // Posts per type — powers a simple bar chart in the admin.
    const byType = await Post.aggregate([
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // New users over the last 7 days.
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const newUsers = await User.countDocuments({ createdAt: { $gte: since } });

    return res.json({
      totals: { users, posts, comments, bannedUsers, newUsersLast7d: newUsers },
      postsByType: byType.map((t) => ({ type: t._id, count: t.count })),
    });
  } catch (err) {
    console.error('admin stats error', err);
    return res.status(500).json({ error: 'Could not load stats' });
  }
}

export async function listUsers(req, res) {
  try {
    const { q, limit } = req.query;
    const lim = Math.min(Number(limit) || 50, 100);
    const filter = q
      ? { $or: [{ username: new RegExp(q, 'i') }, { email: new RegExp(q, 'i') }] }
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
    console.error('listUsers error', err);
    return res.status(500).json({ error: 'Could not list users' });
  }
}

export async function setBanned(req, res) {
  try {
    const { banned } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { banned: Boolean(banned) },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ id: user._id, banned: user.banned });
  } catch (err) {
    console.error('setBanned error', err);
    return res.status(500).json({ error: 'Could not update user' });
  }
}

export async function listPosts(req, res) {
  try {
    const { limit } = req.query;
    const lim = Math.min(Number(limit) || 50, 100);
    const posts = await Post.find().sort({ createdAt: -1 }).limit(lim).populate('author');
    return res.json({ posts: posts.map((p) => ({ ...p.toClient(), author: p.author?.toPublic?.() })) });
  } catch (err) {
    console.error('admin listPosts error', err);
    return res.status(500).json({ error: 'Could not list posts' });
  }
}

export async function deletePost(req, res) {
  try {
    const post = await Post.findByIdAndDelete(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    await Comment.deleteMany({ post: post._id });
    return res.json({ ok: true });
  } catch (err) {
    console.error('admin deletePost error', err);
    return res.status(500).json({ error: 'Could not delete post' });
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
      .populate('reporter')
      .populate('post')
      .populate('reportedUser');
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
    console.error('listReports error', err);
    return res.status(500).json({ error: 'Could not load reports' });
  }
}

export async function resolveReport(req, res) {
  try {
    const { status } = req.body;
    if (!REPORT_STATUS.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const report = await Report.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!report) return res.status(404).json({ error: 'Report not found' });
    return res.json({ id: report._id, status: report.status });
  } catch (err) {
    console.error('resolveReport error', err);
    return res.status(500).json({ error: 'Could not update report' });
  }
}
