// scripts/fixProfileComplete.js
//
// Sets profileComplete: true on one user (by username or email), so the app's
// navigator stops routing them to Onboarding. Runs against whatever MONGO_URI
// points at — the same production DB your other scripts use.
//
//   node scripts/fixProfileComplete.js janstovr
//   node scripts/fixProfileComplete.js someone@example.com

import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../src/models/User.js';

const MONGODB_URI = process.env.MONGO_URI;
const handle = process.argv[2];

async function run() {
  if (!MONGODB_URI) throw new Error('MONGO_URI is missing from the environment.');
  if (!handle) throw new Error('Usage: node scripts/fixProfileComplete.js <username-or-email>');

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const query = handle.includes('@')
    ? { email: handle.trim().toLowerCase() }
    : { username: handle.trim() };

  const before = await User.findOne(query, { username: 1, email: 1, profileComplete: 1 }).lean();
  if (!before) { console.log('No user found for:', handle); return; }
  console.log('Before:', before);

  const result = await User.updateOne(query, { $set: { profileComplete: true } });
  console.log(`Matched ${result.matchedCount}, modified ${result.modifiedCount}.`);

  const after = await User.findOne(query, { username: 1, profileComplete: 1 }).lean();
  console.log('After:', after);
}

run()
  .catch((e) => { console.error('Failed:', e.message); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect(); });
