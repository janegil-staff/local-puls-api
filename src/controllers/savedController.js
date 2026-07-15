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

// localpulse/server/src/controllers/savedController.js
export const listSaved = asyncHandler(async (req, res) => {
  const saved = await SavedPost.find({ user: req.userId })
    .sort({ createdAt: -1 })
    .populate({ path: 'post', populate: { path: 'author' } });
  // savedByMe is always true here — this route IS the save list. toClient()
  // can't know that: saves live in the SavedPost collection, not on the post
  // document, so getFeed decorates the flag from a separate query (see
  // postController.js) and this route can just hardcode it.
  const posts = saved
    .filter((s) => s.post)
    .map((s) => ({ ...s.post.toClient(req.userId), savedByMe: true }));
  res.json({ posts });
});