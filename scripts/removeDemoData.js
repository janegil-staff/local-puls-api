// scripts/removeDemoData.js

import 'dotenv/config';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Post from '../src/models/Post.js';

const MONGODB_URI = process.env.MONGO_URI;

async function removeDemoData() {
  if (!MONGODB_URI) {
    throw new Error(
      'MONGO_URI is missing from the environment.',
    );
  }

  await mongoose.connect(MONGODB_URI);

  console.log('Connected to MongoDB.');

  const demoUsers = await User.find(
    { isSeedUser: true },
    { _id: 1, username: 1 },
  ).lean();
    console.log(demoUsers);
  if (demoUsers.length === 0) {
    console.log('No demo users found.');
    return;
  }

  const userIds = demoUsers.map((user) => user._id);

  console.log(
    `Found ${demoUsers.length} demo users.`,
  );

  //
  // Delete posts
  //
  // If your Post model uses `user` instead of `author`,
  // change author -> user.
  //

  const postResult = await Post.deleteMany({
    author: {
      $in: userIds,
    },
  });

  //
  // Delete users
  //

  const userResult = await User.deleteMany({
    _id: {
      $in: userIds,
    },
  });

  console.log('');
  console.log('Demo data removed.');
  console.log(
    `Posts deleted : ${postResult.deletedCount}`,
  );
  console.log(
    `Users deleted : ${userResult.deletedCount}`,
  );
}

removeDemoData()
  .catch((error) => {
    console.error(
      'Remove demo data failed:',
      error,
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });