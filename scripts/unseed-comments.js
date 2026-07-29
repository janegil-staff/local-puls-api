// localpulse/server/scripts/unseed-comments.cjs
//
// Removes ALL seeded comments (isSeed: true) created by seed-comments.cjs.
// Idempotent: safe to run repeatedly; a second run finds nothing and exits.
//
// Run: node scripts/unseed-comments.cjs
//
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('No MONGO_URI in env'); process.exit(1); }
  await mongoose.connect(uri);
  console.log('Connected.');

  const db = mongoose.connection.db;
  const comments = db.collection('comments');
  const posts = db.collection('posts');

  // Count first, so we can report and (if needed) fix denormalized counts.
  const toRemove = await comments.find({ isSeed: true }).project({ _id: 1, post: 1 }).toArray();
  if (toRemove.length === 0) {
    console.log('No seed comments found. Nothing to do.');
    await mongoose.disconnect();
    return;
  }
  console.log(`Found ${toRemove.length} seed comment(s).`);

  // Tally how many seed comments each post had, for optional count fixup.
  const perPost = {};
  for (const c of toRemove) {
    const key = String(c.post);
    perPost[key] = (perPost[key] || 0) + 1;
  }

  const result = await comments.deleteMany({ isSeed: true });
  console.log(`Deleted ${result.deletedCount} seed comment(s).`);

  // OPTIONAL denormalized-count fixup. Only runs if your Post documents carry a
  // numeric commentCount. If they don't, this loop is a harmless no-op because
  // the $inc simply creates/ignores nothing meaningful — but to be safe we only
  // touch posts that actually HAVE the field.
  let fixedPosts = 0;
  for (const [postId, count] of Object.entries(perPost)) {
    try {
      const res = await posts.updateOne(
        { _id: new mongoose.Types.ObjectId(postId), commentCount: { $exists: true } },
        { $inc: { commentCount: -count } }
      );
      if (res.modifiedCount) fixedPosts++;
    } catch {
      /* invalid id or no such post — skip */
    }
  }
  if (fixedPosts > 0) {
    console.log(`Adjusted commentCount on ${fixedPosts} post(s).`);
  }

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => { console.error('Unseed failed:', err); process.exit(1); });
