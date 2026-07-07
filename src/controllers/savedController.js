// localpulse/server/src/controllers/savedController.js
import SavedPost from '../models/SavedPost.js';
import Post from '../models/Post.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

export const toggleSave = asyncHandler(async (req, res) => {
  const post = await Post.findById(req.params.postId);
  if (!post) throw ApiError.notFound('Post not found');

  const existing = await SavedPost.findOne({ user: req.userId, post: post._id });
  if (existing) {
    await existing.deleteOne();
    return res.json({ saved: false });
  }
  await SavedPost.create({ user: req.userId, post: post._id });
  res.json({ saved: true });
});

export const listSaved = asyncHandler(async (req, res) => {
  const saved = await SavedPost.find({ user: req.userId })
    .sort({ createdAt: -1 })
    .populate({ path: 'post', populate: { path: 'author' } });
  const posts = saved
    .filter((s) => s.post)
    .map((s) => s.post.toClient(req.userId));
  res.json({ posts });
});
