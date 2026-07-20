// server/src/scripts/removeSeedUsers.js
import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../src/models/User.js';

const MONGODB_URI = process.env.MONGO_URI;

const SEED_USER_EMAILS = [
  'isabelle@example.test',
  'matthew@example.test',
  'sophie@example.test',
  'alex@example.test',
  'lena@example.test',
  'lukas@example.test',
];

async function removeSeedUsers() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is missing from the environment.');
  }

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const result = await User.deleteMany({
    email: { $in: SEED_USER_EMAILS },
  });

  console.log(`Removed ${result.deletedCount} seeded users.`);
}

removeSeedUsers()
  .catch((error) => {
    console.error('Removing seeded users failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });