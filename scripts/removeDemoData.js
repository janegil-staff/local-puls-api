// scripts/removeDemoData.js

import 'dotenv/config';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Post from '../src/models/Post.js';

const MONGODB_URI = process.env.MONGO_URI;

// The demo users all use @example.test emails (see seedDemoData.js). Targeting
// by this domain is reliable because `email` is a real schema field, unlike
// isSeedUser which may not be defined in User.js (and would then be dropped by
// Mongoose on save — the usual reason a { isSeedUser: true } query returns []).
const DEMO_EMAIL_DOMAIN = '@example.test';

async function removeDemoData() {
  if (!MONGODB_URI) {
    throw new Error('MONGO_URI is missing from the environment.');
  }

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  // Match demo users by email domain OR the isSeedUser flag, so this works
  // whether or not isSeedUser persisted. The regex is anchored to the end of
  // the string so it can't match a real user who merely contains the text.
  const query = {
    $or: [
      { email: { $regex: `${DEMO_EMAIL_DOMAIN.replace('.', '\\.')}$`, $options: 'i' } },
      { isSeedUser: true },
    ],
  };

  const demoUsers = await User.find(query, { _id: 1, username: 1, email: 1 }).lean();
  console.log(demoUsers);

  if (demoUsers.length === 0) {
    console.log('No demo users found.');
    return;
  }

  const userIds = demoUsers.map((user) => user._id);
  console.log(`Found ${demoUsers.length} demo users.`);

  // Delete their posts first (author references these users).
  const postResult = await Post.deleteMany({ author: { $in: userIds } });

  // Then the users themselves.
  const userResult = await User.deleteMany({ _id: { $in: userIds } });

  console.log('');
  console.log('Demo data removed.');
  console.log(`Posts deleted : ${postResult.deletedCount}`);
  console.log(`Users deleted : ${userResult.deletedCount}`);
}

removeDemoData()
  .catch((error) => {
    console.error('Remove demo data failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });