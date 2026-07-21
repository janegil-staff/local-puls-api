// Run from local-pulse-api root: node patch-feed-commentcount.cjs
const fs = require('fs');
const p = 'src/controllers/postController.js';
let s = fs.readFileSync(p, 'utf8');

// 1. Add Comment import if missing.
if (!s.includes("import Comment from '../models/Comment.js'")) {
  s = s.replace(
    "import Post, { POST_TYPES } from '../models/Post.js';",
    "import Post, { POST_TYPES } from '../models/Post.js';\nimport Comment from '../models/Comment.js';"
  );
}

// 2. In getFeed, add comment-count aggregation + attach to response.
const oldSaved = `  // Annotate saved state for the viewer.
  let savedSet = new Set();
  if (req.userId) {
    const saved = await SavedPost.find({ user: req.userId, post: { $in: posts.map((p) => p._id) } });
    savedSet = new Set(saved.map((s) => String(s.post)));
  }

  res.json({
    posts: posts.map((p) => ({ ...p.toClient(req.userId), savedByMe: savedSet.has(String(p._id)) })),
  });`;

const newSaved = `  // Annotate saved state for the viewer.
  let savedSet = new Set();
  if (req.userId) {
    const saved = await SavedPost.find({ user: req.userId, post: { $in: posts.map((p) => p._id) } });
    savedSet = new Set(saved.map((s) => String(s.post)));
  }

  // Comment counts — one grouped query for the whole page (compute-on-read).
  const postIds = posts.map((p) => p._id);
  const countRows = await Comment.aggregate([
    { $match: { post: { $in: postIds } } },
    { $group: { _id: '$post', n: { $sum: 1 } } },
  ]);
  const commentCounts = Object.fromEntries(countRows.map((r) => [String(r._id), r.n]));

  res.json({
    posts: posts.map((p) => ({
      ...p.toClient(req.userId),
      savedByMe: savedSet.has(String(p._id)),
      commentCount: commentCounts[String(p._id)] || 0,
    })),
  });`;

if (!s.includes(oldSaved)) {
  console.error('❌ getFeed block not found — may already be patched or differs.');
  process.exit(1);
}
s = s.replace(oldSaved, newSaved);

// 3. createPost: a fresh post has 0 comments.
s = s.replace(
  "res.status(201).json({ post: post.toClient(req.userId) });",
  "res.status(201).json({ post: { ...post.toClient(req.userId), commentCount: 0 } });"
);

fs.writeFileSync(p, s);
console.log('✅ postController patched: commentCount added to getFeed + createPost.');
