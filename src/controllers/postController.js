// localpulse/server/src/controllers/postController.js
import Post, { POST_TYPES } from "../models/Post.js";
import Comment from "../models/Comment.js";
import Block from "../models/Block.js";
import SavedPost from "../models/SavedPost.js";
import User from "../models/User.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { notify } from "../lib/notify.js";

// Metres per radian on Earth's surface — $centerSphere takes radians.
const EARTH_RADIUS_M = 6378137;

// Used when nobody has expressed a preference: a signed-out viewer, or a
// signed-in one whose profile predates the setting.
const DEFAULT_RADIUS_M = 50000;

export const createPost = asyncHandler(async (req, res) => {
  const { text, type, lng, lat, placeName, imageUrl } = req.body;
  if (!text || !text.trim()) throw ApiError.badRequest("Post text is required");
  if (type && !POST_TYPES.includes(type)) {
    throw ApiError.badRequest(`type must be one of: ${POST_TYPES.join(", ")}`);
  }

  const post = await Post.create({
    author: req.userId,
    text: text.trim(),
    type: type || "update",
    placeName: placeName || "",
    imageUrl: imageUrl || "",
    location:
      lng != null && lat != null
        ? { type: "Point", coordinates: [Number(lng), Number(lat)] }
        : undefined,
  });

  await post.populate("author");
  res
    .status(201)
    .json({ post: { ...post.toClient(req.userId), commentCount: 0 } });
});

/**
 * Where this viewer's feed is centred, and how far it reaches.
 *
 *   { center: [lng, lat] | null, radiusMeters: number | null }
 *
 * BOTH come from the USER document, not the query string — and that is the
 * point. discoveryController centres the people grid on the viewer's
 * browseLocation (or their real location), while this endpoint used to centre
 * on whatever coordinates the DEVICE reported. Those are different places
 * whenever someone is browsing another area, or whenever the device's fix is
 * stale or wrong.
 *
 * The visible symptom: a person shows up in Discover but the post they wrote
 * does not appear in the feed, with the same distance setting on both. Same
 * radius, different origin.
 *
 * The query string is still honoured for signed-out callers, who have no
 * stored location to centre on.
 */
async function viewerGeo(req) {
  const { lng, lat, radius } = req.query;

  if (!req.userId) {
    return {
      center: lng != null && lat != null ? [Number(lng), Number(lat)] : null,
      radiusMeters: Number(radius) || DEFAULT_RADIUS_M,
    };
  }

  const me = await User.findById(req.userId).select(
    "location browseLocation preferences.maxDistanceKm",
  );

  // Browse location wins when set — the same precedence discoveryController
  // uses. Someone browsing Oslo should see Oslo posts, not posts near the
  // phone in their pocket.
  const stored =
    me?.browseLocation?.coordinates?.length === 2
      ? me.browseLocation.coordinates
      : me?.location?.coordinates?.length === 2
        ? me.location.coordinates
        : null;

  // Fall back to the device's coordinates only when the account has no stored
  // location at all — a brand-new user mid-onboarding.
  const center =
    stored || (lng != null && lat != null ? [Number(lng), Number(lat)] : null);

  const km = me?.preferences?.maxDistanceKm;

  // null (Anywhere) and undefined (account predates the field) both mean no
  // limit — matching the schema default and discoveryController. Any other
  // reading here would silently disagree with the people grid.
  const radiusMeters = km == null ? null : Number(km) * 1000;

  return { center, radiusMeters };
}

// Feed: always newest-first.
//
// When coords are given AND the viewer has a distance limit, posts within range
// are included ALONG WITH posts that have no location — so nothing is silently
// stranded off-map. $geoWithin filters without imposing distance ordering,
// unlike $near, so the createdAt sort actually applies.
//
// When the viewer has chosen Anywhere, no geo filter is applied at all, even if
// the client sent coordinates. Anywhere means everything.
export const getFeed = asyncHandler(async (req, res) => {
  const { before, limit } = req.query;
  const lim = Math.min(Number(limit) || 20, 50);

  // Exclude people I blocked + people who blocked me.
  let excludeIds = [];
  if (req.userId) {
    const blocks = await Block.find({
      $or: [{ blocker: req.userId }, { blocked: req.userId }],
    });
    excludeIds = blocks.map((b) =>
      String(b.blocker) === String(req.userId) ? b.blocked : b.blocker,
    );
  }

  const base = {
    ...(excludeIds.length ? { author: { $nin: excludeIds } } : {}),
    ...(before ? { createdAt: { $lt: new Date(before) } } : {}),
  };

  const { center, radiusMeters } = await viewerGeo(req);

  let query = base;
  if (center && radiusMeters != null) {
    query = {
      ...base,
      $or: [
        {
          location: {
            $geoWithin: {
              $centerSphere: [center, radiusMeters / EARTH_RADIUS_M],
            },
          },
        },
        // Posts with no coordinates are shown to everyone rather than hidden.
        // A post made with location permission denied is still a real post,
        // and dropping it would penalise the author for a device setting.
        { location: { $exists: false } },
      ],
    };
  }

  const posts = await Post.find(query)
    .sort({ createdAt: -1 })
    .limit(lim)
    .populate("author");

  // Annotate saved state for the viewer.
  let savedSet = new Set();
  if (req.userId) {
    const saved = await SavedPost.find({
      user: req.userId,
      post: { $in: posts.map((p) => p._id) },
    });
    savedSet = new Set(saved.map((s) => String(s.post)));
  }

  // Comment counts — one grouped query for the whole page (compute-on-read).
  const postIds = posts.map((p) => p._id);
  const countRows = await Comment.aggregate([
    { $match: { post: { $in: postIds } } },
    { $group: { _id: "$post", n: { $sum: 1 } } },
  ]);
  const commentCounts = Object.fromEntries(
    countRows.map((r) => [String(r._id), r.n]),
  );

  res.json({
    posts: posts.map((p) => ({
      ...p.toClient(req.userId),
      savedByMe: savedSet.has(String(p._id)),
      commentCount: commentCounts[String(p._id)] || 0,
    })),
    // Echoed back so the client can show "within 50 km" or "anywhere" without
    // recomputing it, and so a mismatch between what the user set and what the
    // server applied is visible rather than silent.
    radiusKm: radiusMeters == null ? null : radiusMeters / 1000,
  });
});

export const toggleLike = asyncHandler(async (req, res) => {
  const post = await Post.findById(req.params.id).populate("author");
  if (!post) throw ApiError.notFound("Post not found");

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
      type: "like",
      postId: post._id,
      title: "New like",
      body: "Someone liked your post",
    });
  }

  res.json({ likedByMe: !already, likeCount: post.likes.length });
});
