// localpulse/server/scripts/seedFeed.js
//
// Seeds sample feed posts into MongoDB, authored by EXISTING users, with
// GeoJSON coordinates jittered around a center point so they surface in the
// nearby (2dsphere) feed. Matches src/models/Post.js exactly.
//
// Run from the server root:
//   node scripts/seedFeed.js                       # seeds near Sandnes (default)
//   node scripts/seedFeed.js --lat=58.97 --lng=5.73  # seed near a point
//   node scripts/seedFeed.js --count=7             # cap number of posts
//   node scripts/seedFeed.js --clear               # remove prior seeded posts, then seed
//   node scripts/seedFeed.js --confirm             # required if DB host looks like prod
//
// Idempotency: seeded posts are tagged with a marker in `placeName`-independent
// way — we store a sentinel in a Map keyed by text is fragile, so instead we tag
// via a dedicated marker in the imageUrl-independent field set below. Simplest
// robust approach: we prefix nothing on the post but keep a known set of texts;
// --clear deletes any post whose text is in SEED_TEXTS. Re-running without
// --clear appends (so you can seed more), with --clear it replaces.

import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../src/models/User.js';
import Post from '../src/models/Post.js';

// ── args ────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const CENTER = {
  lat: args.lat != null ? Number(args.lat) : 58.8522, // Sandnes
  lng: args.lng != null ? Number(args.lng) : 5.7361,
};
const COUNT = args.count != null ? Number(args.count) : Infinity;

const MONGODB_URI =
  process.env.MONGO_URI || process.env.MONGO_URI || process.env.MONGO_URI;

if (!MONGODB_URI) {
  console.error('No Mongo connection string found (MONGODB_URI / MONGO_URL / DATABASE_URL).');
  process.exit(1);
}

// Guard against accidentally seeding a production database. If the host doesn't
// look local and --confirm wasn't passed, bail.
const looksProd = !/localhost|127\.0\.0\.1|mongo:27017/.test(MONGODB_URI);
if (looksProd && !args.confirm) {
  console.error(
    `Refusing to seed what looks like a remote/prod DB:\n  ${MONGODB_URI.replace(/\/\/[^@]*@/, '//<credentials>@')}\n` +
    `Re-run with --confirm if you really mean to seed this database.`
  );
  process.exit(1);
}

// ── sample content (text is the idempotency key for --clear) ────────────
const minsAgo = (m) => new Date(Date.now() - m * 60_000);
const jitter = () => (Math.random() - 0.5) * 0.02; // ~±1km

const SEED_POSTS = [
  {
    type: 'event',
    text: 'Beach volleyball at Sola strand this Saturday 14:00 — we need two more players. Beginners very welcome, we just want a good time. 🏐',
    imageUrl: 'https://images.unsplash.com/photo-1612872087720-bb876e2e67d1?w=1200&q=80',
    placeName: 'Sola strand',
    minutesAgo: 4,
    likes: 12,
  },
  {
    type: 'question',
    text: 'Moved to Sandnes last week. Where do people actually get good coffee around here? Not a chain — somewhere with character.',
    imageUrl: '',
    placeName: 'Sandnes sentrum',
    minutesAgo: 38,
    likes: 7,
  },
  {
    type: 'update',
    text: 'Sunset run along the fjord tonight. Six months ago I couldn’t do 2 km without stopping. Small steps add up. 🏃‍♀️',
    imageUrl: 'https://images.unsplash.com/photo-1502904550040-7534597429ae?w=1200&q=80',
    placeName: 'Gandsfjorden',
    minutesAgo: 95,
    likes: 41,
  },
  {
    type: 'recommendation',
    text: 'The new ramen place near the train station is the real deal. Tonkotsu broth, proper chashu. Go before the queues figure it out.',
    imageUrl: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=1200&q=80',
    placeName: 'Jærbanen stasjon',
    minutesAgo: 180,
    likes: 23,
  },
  {
    type: 'marketplace',
    text: 'Free pile of firewood on my driveway — first come first served. Dry, been under cover all winter. DM for the address. 🔥',
    imageUrl: '',
    placeName: 'Hana',
    minutesAgo: 320,
    likes: 5,
  },
  {
    type: 'event',
    text: 'Board game night at mine on Friday. Wingspan, Catan, whatever people bring. Room for 6, three spots left. Snacks provided.',
    imageUrl: 'https://images.unsplash.com/photo-1610890716171-6b1bb98ffd09?w=1200&q=80',
    placeName: 'Stavanger',
    minutesAgo: 600,
    likes: 18,
  },
  {
    type: 'lostfound',
    text: 'Found a set of keys with a red climbing carabiner near Ruten this morning. Describe them and they’re yours.',
    imageUrl: '',
    placeName: 'Ruten, Sandnes',
    minutesAgo: 900,
    likes: 2,
  },
  {
    type: 'question',
    text: 'Anyone know a reliable bike mechanic nearby? Gears slipping and I’m out of my depth. Willing to pay for someone who knows their stuff.',
    imageUrl: '',
    placeName: 'Bryne',
    minutesAgo: 1440,
    likes: 3,
  },
];

const SEED_TEXTS = SEED_POSTS.map((p) => p.text);

// ── run ─────────────────────────────────────────────────────────────────
async function main() {
  await mongoose.connect(MONGODB_URI);
  const host = mongoose.connection.host;
  console.log(`Connected to ${host}/${mongoose.connection.name}`);

  // Authors: existing users only.
  const users = await User.find().select('_id').limit(50);
  if (users.length === 0) {
    console.error('No users in the database — create at least one user first.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Found ${users.length} user(s) to author posts.`);

  if (args.clear) {
    const del = await Post.deleteMany({ text: { $in: SEED_TEXTS } });
    console.log(`Cleared ${del.deletedCount} previously-seeded post(s).`);
  }

  const chosen = SEED_POSTS.slice(0, Number.isFinite(COUNT) ? COUNT : SEED_POSTS.length);

  const docs = chosen.map((p, i) => {
    const author = users[i % users.length]._id;
    // A handful of likers drawn from other users (never the author).
    const likers = users
      .filter((u) => String(u._id) !== String(author))
      .slice(0, p.likes)
      .map((u) => u._id);

    return {
      author,
      type: p.type,
      text: p.text,
      imageUrl: p.imageUrl,
      placeName: p.placeName,
      // GeoJSON is [lng, lat] — longitude FIRST. Jittered around the center so
      // posts aren't stacked on one pin and fall inside a typical nearby radius.
      location: {
        type: 'Point',
        coordinates: [CENTER.lng + jitter(), CENTER.lat + jitter()],
      },
      likes: likers,
      createdAt: minsAgo(p.minutesAgo),
      updatedAt: minsAgo(p.minutesAgo),
    };
  });

  // timestamps:true would overwrite createdAt on .create(); insertMany with
  // explicit createdAt is respected, so the relative times survive.
  const inserted = await Post.insertMany(docs);
  console.log(`Inserted ${inserted.length} post(s) near ${CENTER.lat},${CENTER.lng}.`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(async (err) => {
  console.error('Seed failed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
