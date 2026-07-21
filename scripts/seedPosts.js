// scripts/seedPosts.js
//
// Creates 30 posts authored by EXISTING seeded users (isSeedUser: true), each
// with random likes from other seeded users. Standalone — does not touch user
// documents. Deletes those users' old posts first so re-runs don't pile up.
//
//   node scripts/seedPosts.js
//   node scripts/seedPosts.js --count 40           # different number of posts
//   node scripts/seedPosts.js --lat 60.39 --lng 5.32   # scatter center (default Bergen)
//
// Matches the Post model: author (ObjectId), type (enum), text (required,
// <=1000), imageUrl (string, '' allowed), location (GeoJSON Point [lng,lat]),
// placeName, likes ([ObjectId]).

import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../src/models/User.js';
import Post from '../src/models/Post.js';

const MONGODB_URI = process.env.MONGO_URI;

// ── args ──────────────────────────────────────────────
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const COUNT = Number(arg('count', 30));
// Default center: Bergen, so posts sit where you test from.
const CENTER_LAT = Number(arg('lat', 60.3913));
const CENTER_LNG = Number(arg('lng', 5.3221));

const POST_TYPES = ['update', 'event', 'recommendation', 'lostfound', 'marketplace', 'question'];

// Text pools per type, so text matches the post kind.
const TEXTS = {
  update: [
    'Perfect weather for a walk around the neighborhood today.',
    'A quiet moment in the city after a busy week.',
    'Slow Saturday morning with coffee and no plans.',
    'The evening light over the city was worth stopping for.',
    'Making the most of the weekend close to home.',
  ],
  event: [
    'Beginner-friendly morning run tomorrow. Everyone is welcome.',
    'Small acoustic concert this Friday evening.',
    'Planning an easy weekend hike. Message me if you want to join.',
    'Free outdoor dance session on Sunday afternoon.',
    'A few of us are meeting for a casual walk this evening.',
  ],
  recommendation: [
    'This café has become one of my favorite places to work.',
    'Highly recommend this place for a relaxed weekend lunch.',
    'Found a beautiful walking route nearby today.',
    'Great little restaurant with a relaxed atmosphere.',
    'The bakery around the corner is absolutely worth trying.',
  ],
  lostfound: [
    'Found a set of keys near the park. Message me if they might be yours.',
    'Has anyone seen a small black backpack around the neighborhood?',
    'Found a pair of sunglasses near the tram stop.',
    'A bicycle light was left outside the café this afternoon.',
  ],
  marketplace: [
    'Selling a comfortable desk chair in good condition.',
    'Giving away a bookshelf to anyone who can pick it up.',
    'Selling two tickets for a local concert this weekend.',
    'Moving soon and selling a few household items.',
  ],
  question: [
    'Where is the best place for brunch around here?',
    'What is your favorite walking route in this area?',
    'Can anyone recommend a reliable bicycle repair shop?',
    'Are there any beginner-friendly running groups nearby?',
    'Does anyone know a good quiet café for working remotely?',
  ],
};

// Place names to pair with the scattered coordinates (flavor only).
const PLACE_NAMES = ['Sentrum', 'Nordnes', 'Møhlenpris', 'Sandviken', 'Årstad', 'Laksevåg', 'Landås', 'Solheim'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Jitter a point within ~`km` of the center. [lng, lat] out.
function jitter(lat, lng, km = 5) {
  const dLat = (Math.random() - 0.5) * 2 * (km / 111);
  const dLng = (Math.random() - 0.5) * 2 * (km / (111 * Math.cos(lat * Math.PI / 180)));
  return [lng + dLng, lat + dLat];
}

function randomLikes(users, authorId) {
  const others = users.filter((u) => String(u._id) !== String(authorId));
  const n = Math.floor(Math.random() * 11); // 0–10 likes
  // shuffle + take n
  const copy = [...others];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n).map((u) => u._id);
}

function randomDateWithinLastDays(days) {
  return new Date(Date.now() - Math.floor(Math.random() * days * 24 * 60 * 60 * 1000));
}

async function run() {
  if (!MONGODB_URI) throw new Error('MONGO_URI is missing from the environment.');

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  // Authors: existing seeded users only.
  const users = await User.find({ isSeedUser: true }, { _id: 1, username: 1 }).lean();
  if (users.length === 0) {
    console.log('No seeded users (isSeedUser: true) found. Seed users first.');
    return;
  }
  console.log(`Found ${users.length} seeded users to author posts.`);

  // Clear these users' old posts so re-runs don't accumulate.
  const userIds = users.map((u) => u._id);
  const del = await Post.deleteMany({ author: { $in: userIds } });
  console.log(`Removed ${del.deletedCount} old posts by seeded users.`);

  // Build documents.
  const docs = [];
  for (let i = 0; i < COUNT; i += 1) {
    const author = pick(users);
    const type = POST_TYPES[i % POST_TYPES.length]; // even spread across types
    const [lng, lat] = jitter(CENTER_LAT, CENTER_LNG, 5);
    const createdAt = randomDateWithinLastDays(30);

    docs.push({
      author: author._id,
      type,
      text: pick(TEXTS[type]),
      imageUrl: '', // no image dependency — keeps this script self-contained
      location: { type: 'Point', coordinates: [lng, lat] },
      placeName: pick(PLACE_NAMES),
      likes: randomLikes(users, author._id),
      createdAt,
      updatedAt: createdAt,
    });
  }

  // ordered:false so one bad doc can't abort the whole batch; report any errors.
  let inserted = [];
  try {
    inserted = await Post.insertMany(docs, { ordered: false });
  } catch (err) {
    console.error('insertMany reported errors:');
    if (err.writeErrors) {
      for (const we of err.writeErrors) {
        console.error(`  index ${we.index}: ${we.errmsg || we.err?.errmsg}`);
      }
    } else {
      console.error(err.message);
    }
    // Some may still have inserted; report what we know.
    inserted = err.insertedDocs || [];
  }

  const totalLikes = inserted.reduce((s, p) => s + (p.likes?.length || 0), 0);
  console.log('');
  console.log(`Created ${inserted.length} posts.`);
  console.log(`Total likes across posts: ${totalLikes}`);
  console.log(`Scatter center: [lng ${CENTER_LNG}, lat ${CENTER_LAT}] (~5km spread).`);
}

run()
  .catch((e) => { console.error('Seed posts failed:', e.message); process.exitCode = 1; })
  .finally(async () => { if (mongoose.connection.readyState !== 0) await mongoose.disconnect(); });
