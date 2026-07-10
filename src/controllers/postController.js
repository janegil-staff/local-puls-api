// localpulse/server/src/controllers/postController.js
import Post, { POST_TYPES } from '../models/Post.js';
import Block from '../models/Block.js';
import SavedPost from '../models/SavedPost.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { notify } from '../lib/notify.js';

export const createPost = asyncHandler(async (req, res) => {
  const { text, type, lng, lat, placeName, imageUrl } = req.body;
  if (!text || !text.trim()) throw ApiError.badRequest('Post text is required');
  if (type && !POST_TYPES.includes(type)) {
    throw ApiError.badRequest(`type must be one of: ${POST_TYPES.join(', ')}`);
  }

  const post = await Post.create({
    author: req.userId,
    text: text.trim(),
    type: type || 'update',
    placeName: placeName || '',
    imageUrl: imageUrl || '',
    location:
      lng != null && lat != null
        ? { type: 'Point', coordinates: [Number(lng), Number(lat)] }
        : undefined,
  });

  await post.populate('author');
  res.status(201).json({ post: post.toClient(req.userId) });
});

// Feed: always newest-first. When coords are given, posts within range are
// included AND posts with no location (never defaulted to [0,0] anymore) — so
// nothing is silently stranded off-map. $geoWithin filters without imposing
// distance ordering, unlike $near, so the createdAt sort actually applies.
export const getFeed = asyncHandler(async (req, res) => {
  const { lng, lat, radius, before, limit } = req.query;
  const lim = Math.min(Number(limit) || 20, 50);

  // Exclude people I blocked + people who blocked me.
  let excludeIds = [];
  if (req.userId) {
    const blocks = await Block.find({
      $or: [{ blocker: req.userId }, { blocked: req.userId }],
    });
    excludeIds = blocks.map((b) =>
      String(b.blocker) === String(req.userId) ? b.blocked : b.blocker
    );
  }

  const base = {
    ...(excludeIds.length ? { author: { $nin: excludeIds } } : {}),
    ...(before ? { createdAt: { $lt: new Date(before) } } : {}),
  };

  // 6378137 = Earth's radius in metres ($centerSphere wants radians).
  let query = base;
  if (lng != null && lat != null) {
    const meters = Number(radius) || 50000;
    query = {
      ...base,
      $or: [
        {
          location: {
            $geoWithin: { $centerSphere: [[Number(lng), Number(lat)], meters / 6378137] },
          },
        },
        { location: { $exists: false } },
      ],
    };
  }

  const posts = await Post.find(query)
    .sort({ createdAt: -1 })
    .limit(lim)
    .populate('author');

  // Annotate saved state for the viewer.
  let savedSet = new Set();
  if (req.userId) {
    const saved = await SavedPost.find({ user: req.userId, post: { $in: posts.map((p) => p._id) } });
    savedSet = new Set(saved.map((s) => String(s.post)));
  }

  res.json({
    posts: posts.map((p) => ({ ...p.toClient(req.userId), savedByMe: savedSet.has(String(p._id)) })),
  });
});

export const toggleLike = asyncHandler(async (req, res) => {
  const post = await Post.findById(req.params.id).populate('author');
  if (!post) throw ApiError.notFound('Post not found');

  const already = post.likes.some((id) => String(id) === String(req.userId));
  if (already) {
    post.likes = post.likes.filter((id) => String(id) !== String(req.userId));
  } else {
    post.likes.push(req.userId);
  }
  await post.save();

  // Fire a like notification only on new likes.
  if (!already) {
    await notify({
      userId: post.author._id,
      actorId: req.userId,
      type: 'like',
      postId: post._id,
      title: 'New like',
      body: 'Someone liked your post',
    });
  }

  res.json({ likedByMe: !already, likeCount: post.likes.length });
});