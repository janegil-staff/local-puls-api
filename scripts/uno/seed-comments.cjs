// localpulse/server/scripts/seed-comments.cjs
//
// Seeds 1–3 comments (mixed across 12 locales) onto each SEEDED post, authored
// by random seed users. Idempotent: skips posts that already have seed comments,
// so re-running never piles up.
//
// Cleanup:  node -e "require('mongoose').connect(process.env.MONGO_URI).then(async m=>{await m.connection.collection('comments').deleteMany({isSeedPost:true});process.exit(0)})"
//   or:     Comment.deleteMany({ isSeedPost: true })
//
// Run: node scripts/seed-comments.cjs
//
require('dotenv').config();
const mongoose = require('mongoose');

// ⚠️ CONFIRM these against your actual models before running.
// - Comment schema must have: post (ref Post), author (ref User), text, isSeed
// - "Seeded post" identification: see SEEDED_POST_QUERY below.
const COMMENT_MIN_LEN = 1;   // TODO: match your Comment text minlength
const COMMENT_MAX_LEN = 500; // TODO: match your Comment text maxlength

// Mixed-locale comment pool. Kept generic/positive so they fit any post.
// no, en, nl, fr, de, it, sv, da, fi, es, pl, pt
const COMMENTS = [
  'Så bra! 🙌',                       // no
  'Elsker dette!',                    // no
  'Love this!',                       // en
  'This is great 👏',                 // en
  'Wat leuk!',                        // nl
  'Mooi zo!',                         // nl
  'Trop bien !',                      // fr
  'J’adore 😍',                       // fr
  'Wie schön!',                       // de
  'Toll gemacht!',                    // de
  'Che bello!',                       // it
  'Bellissimo 😍',                    // it
  'Vad fint!',                        // sv
  'Snyggt! 🙌',                       // sv
  'Hvor fedt!',                       // da
  'Super lækkert',                    // da
  'Mahtavaa!',                        // fi
  'Tosi hyvä 👏',                     // fi
  '¡Qué bueno! 🙌',                   // es
  'Me encanta 😍',                    // es
  'Świetne!',                         // pl
  'Uwielbiam to ❤️',                  // pl
  'Que fixe!',                        // pt
  'Adoro isto 😍',                    // pt
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('No MONGO_URI in env'); process.exit(1); }
  await mongoose.connect(uri);
  console.log('Connected.');

  const db = mongoose.connection.db;
  const users = db.collection('users');
  const posts = db.collection('posts');
  const comments = db.collection('comments');

  // Seed users = the pool of commenters.
  const seedUsers = await users.find({ isSeedUser: true }).project({ _id: 1 }).toArray();
  if (seedUsers.length === 0) {
    console.error('No seed users (isSeedUser:true) found. Aborting.');
    process.exit(1);
  }
  const seedUserIds = seedUsers.map((u) => u._id);
  console.log(`Found ${seedUserIds.length} seed users.`);

  // SEEDED_POST_QUERY: TODO confirm how a seeded post is identified.
  // Option A — a post has its own isSeed flag:      { isSeedPost: true }
  // Option B — a post is authored by a seed user:   { author: { $in: seedUserIds } }
  // Defaulting to Option B since your snippet put isSeedUser on the User.
  const seededPosts = await posts
    .find({ author: { $in: seedUserIds } })
    .project({ _id: 1, author: 1 })
    .toArray();
  console.log(`Found ${seededPosts.length} seeded posts.`);

  let created = 0;
  let skipped = 0;

  for (const post of seededPosts) {
    // Idempotent: skip posts that already have seed comments.
    const existing = await comments.countDocuments({ post: post._id, isSeedPost: true });
    if (existing > 0) { skipped++; continue; }

    const n = 1 + Math.floor(Math.random() * 3); // 1–3

    // Commenters: seed users other than the post's author.
    const eligible = seedUserIds.filter((id) => String(id) !== String(post.author));
    const commenters = pickN(eligible.length ? eligible : seedUserIds, n);

    const now = Date.now();
    const docs = commenters.map((authorId, i) => {
      let text = pick(COMMENTS);
      if (text.length < COMMENT_MIN_LEN) text = 'Nice!';
      if (text.length > COMMENT_MAX_LEN) text = text.slice(0, COMMENT_MAX_LEN);
      return {
        post: post._id,
        author: authorId,
        text,
        isSeedPost: true,
        // Stagger timestamps so they don't all share one instant.
        createdAt: new Date(now - (n - i) * 60000),
        updatedAt: new Date(now - (n - i) * 60000),
      };
    });

    if (docs.length) {
      await comments.insertMany(docs);
      created += docs.length;
    }
  }

  console.log(`\nDone. Created ${created} seed comment(s) across ${seededPosts.length - skipped} post(s). Skipped ${skipped} already-seeded post(s).`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error('Seed failed:', err); process.exit(1); });
