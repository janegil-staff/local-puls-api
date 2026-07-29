import 'dotenv/config';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

const EMAIL = process.argv[2];
if (!EMAIL) {
  console.error('usage: node src/scripts/token.mjs someone@example.test');
  process.exit(1);
}

await mongoose.connect(config.mongoUri);
const user = await mongoose.connection.db
  .collection('users')
  .findOne({ email: EMAIL.toLowerCase() });

if (!user) {
  console.log('No user with that email.');
} else {
  // Same claim the app's signToken uses — the id goes in `sub`.
  console.log(jwt.sign({ sub: String(user._id) }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  }));
}

await mongoose.disconnect();
