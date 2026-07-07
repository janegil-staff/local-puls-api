// localpulse/server/src/lib/seed.js
// Populate a dev database with users + Bergen-area posts so the feed isn't empty.
// Run: npm run seed
import mongoose from 'mongoose';
import User from '../models/User.js';
import Post from '../models/Post.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/localpulse';

// Bergen center-ish, with small offsets so "near me" has spread.
const BERGEN = { lng: 5.3221, lat: 60.3913 };
function near() {
  return {
    lng: BERGEN.lng + (Math.random() - 0.5) * 0.05,
    lat: BERGEN.lat + (Math.random() - 0.5) * 0.05,
  };
}

const SAMPLE = [
  { type: 'event', text: 'Fish market gathering Saturday morning — fresh catch and live music!', placeName: 'Torget' },
  { type: 'recommendation', text: 'The new coffee spot in Nordnes has the best cardamom buns in town.', placeName: 'Nordnes' },
  { type: 'lostfound', text: 'Found a set of keys near Fløibanen station. DM to claim.', placeName: 'Fløyen' },
  { type: 'marketplace', text: 'Selling a barely-used kayak, perfect for the fjords. 3000 kr.', placeName: 'Sandviken' },
  { type: 'question', text: 'Anyone know a good electrician in the Bergenhus area?', placeName: 'Bergenhus' },
  { type: 'update', text: 'Beautiful clear day over the seven mountains today ☀️', placeName: 'Ulriken' },
];

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected. Seeding…');

  await Promise.all([User.deleteMany({}), Post.deleteMany({})]);

  const usersData = [
    { username: 'ingrid', email: 'ingrid@example.com', displayName: 'Ingrid H.' },
    { username: 'lars', email: 'lars@example.com', displayName: 'Lars B.' },
    { username: 'admin', email: 'admin@example.com', displayName: 'Admin', role: 'admin' },
  ];

  const users = [];
  for (const u of usersData) {
    const user = new User(u);
    await user.setPassword('password123');
    await user.save();
    users.push(user);
  }

  for (let i = 0; i < SAMPLE.length; i++) {
    const s = SAMPLE[i];
    const author = users[i % users.length];
    const { lng, lat } = near();
    await Post.create({
      author: author._id,
      type: s.type,
      text: s.text,
      placeName: s.placeName,
      location: { type: 'Point', coordinates: [lng, lat] },
    });
  }

  console.log(`Seeded ${users.length} users and ${SAMPLE.length} posts.`);
  console.log('Login with any of: ingrid / lars / admin  (password: password123)');
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
