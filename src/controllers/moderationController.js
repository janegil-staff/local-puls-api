// localpulse/server/src/controllers/moderationController.js
import Report, { REPORT_REASONS } from '../models/Report.js';
import Block from '../models/Block.js';
import Post from '../models/Post.js';
import User from '../models/User.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

export const reportPost = asyncHandler(async (req, res) => {
  const { reason, note } = req.body;
  if (!REPORT_REASONS.includes(reason)) throw ApiError.badRequest('Invalid reason');
  const post = await Post.findById(req.params.postId);
  if (!post) throw ApiError.notFound('Post not found');

  await Report.create({ reporter: req.userId, post: post._id, reason, note: note || '' });
  res.status(201).json({ ok: true });
});

export const reportUser = asyncHandler(async (req, res) => {
  const { reason, note } = req.body;
  if (!REPORT_REASONS.includes(reason)) throw ApiError.badRequest('Invalid reason');
  const user = await User.findById(req.params.userId);
  if (!user) throw ApiError.notFound('User not found');

  await Report.create({ reporter: req.userId, reportedUser: user._id, reason, note: note || '' });
  res.status(201).json({ ok: true });
});

export const blockUser = asyncHandler(async (req, res) => {
  if (String(req.params.userId) === String(req.userId)) {
    throw ApiError.badRequest("You can't block yourself");
  }
  await Block.updateOne(
    { blocker: req.userId, blocked: req.params.userId },
    { $setOnInsert: { blocker: req.userId, blocked: req.params.userId } },
    { upsert: true }
  );
  res.json({ blocked: true });
});

export const unblockUser = asyncHandler(async (req, res) => {
  await Block.deleteOne({ blocker: req.userId, blocked: req.params.userId });
  res.json({ blocked: false });
});

export const listBlocked = asyncHandler(async (req, res) => {
  const blocks = await Block.find({ blocker: req.userId }).populate('blocked');
  res.json({
    blocked: blocks.map((b) => (b.blocked?.toPublic ? b.blocked.toPublic() : b.blocked)),
  });
});
