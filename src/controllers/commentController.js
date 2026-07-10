// localpulse/server/src/controllers/commentController.js
import Comment from '../models/Comment.js';
import Post from '../models/Post.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { notify } from '../lib/notify.js';

export const listComments = asyncHandler(async (req, res) => {
  const comments = await Comment.find({ post: req.params.postId })
    .sort({ createdAt: 1 })
    .populate('author');
  res.json({ comments: comments.map((c) => c.toClient()) });
});

export const addComment = asyncHandler(async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) throw ApiError.badRequest('Comment text required');

  const post = await Post.findById(req.params.postId);
  if (!post) throw ApiError.notFound('Post not found');

  const comment = await Comment.create({
    post: post._id,
    author: req.userId,
    text: text.trim(),
  });
  await comment.populate('author');

  // Notification must never fail the comment. Wrapped so a bad push token,
  // a deleted post author, or a notify bug logs instead of 500-ing a
  // successful write.
  try {
    if (post.author && String(post.author) !== String(req.userId)) {
      await notify({
        userId: post.author,
        actorId: req.userId,
        type: 'comment',
        postId: post._id,
        title: 'New comment',
        body: text.trim().slice(0, 80),
      });
    }
  } catch (err) {
    console.error('comment notify failed', err);
  }

  res.status(201).json({ comment: comment.toClient() });
});

export const deleteComment = asyncHandler(async (req, res) => {
  const comment = await Comment.findById(req.params.id);
  if (!comment) throw ApiError.notFound('Comment not found');
  if (String(comment.author) !== String(req.userId) && req.userRole !== 'admin') {
    throw ApiError.forbidden();
  }
  await comment.deleteOne();
  res.json({ ok: true });
});