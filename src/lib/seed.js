// localpulse/server/src/lib/seed.js
// Seed dating profiles around Bergen so discovery has candidates.
// Run: npm run seed
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import User from '../models/User.js';

const BERGEN = { lng: 5.3221, lat: 60.3913 };
function near() {
  return [BERGEN.lng + (Math.random() - 0.5) * 0.08, BERGEN.lat + (Math.random() - 0.5) * 0.08];
}
function dobForAge(age) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - age);
  return d;
}

const PEOPLE = [
  { username: 'ingrid', displayName: 'Ingrid', gender: 'woman', age: 28, neighborhood: 'Nordnes', interests: ['hiking', 'coffee', 'photography'], bio: 'Fjord swimmer and cinnamon-bun enthusiast.' },
  { username: 'lars', displayName: 'Lars', gender: 'man', age: 31, neighborhood: 'Sandviken', interests: ['climbing', 'vinyl', 'cooking'], bio: 'Weekends on Ulriken, weeknights at the record shop.' },
  { username: 'sofie', displayName: 'Sofie', gender: 'woman', age: 26, neighborhood: 'Møhlenpris', interests: ['art', 'cycling', 'jazz'], bio: 'Painter. Will show you the best kaffebar in town.' },
  { username: 'mateo', displayName: 'Mateo', gender: 'man', age: 29, neighborhood: 'Bergenhus', interests: ['running', 'films', 'travel'], bio: 'New to Bergen, learning Norwegian one word at a time.' },
  { username: 'kari', displayName: 'Kari', gender: 'nonbinary', age: 27, neighborhood: 'Landås', interests: ['boardgames', 'baking', 'kayaking'], bio: 'Board game night is non-negotiable.' },
  { username: 'admin', displayName: 'Admin', gender: 'other', age: 35, neighborhood: '', interests: [], bio: '', role: 'admin' },
];

async function run() {
  await mongoose.connect(config.mongoUri);
  console.log('Connected. Seeding dating profiles…');
  await User.deleteMany({});

  for (const p of PEOPLE) {
    const u = new User({
      username: p.username,
      email: `${p.username}@example.com`,
      displayName: p.displayName,
      gender: p.gender,
      dob: dobForAge(p.age),
      bio: p.bio,
      neighborhood: p.neighborhood,
      interests: p.interests,
      photos: p.username === 'admin' ? [] : [`https://picsum.photos/seed/${p.username}/600/800`],
      role: p.role || 'user',
      profileComplete: p.username !== 'admin',
      location: { type: 'Point', coordinates: near() },
      preferences: { show: 'everyone', ageMin: 18, ageMax: 99, maxDistanceKm: 50 },
    });
    await u.setPassword('password123');
    await u.save();
  }

  console.log(`Seeded ${PEOPLE.length} users. Login: ingrid / lars / sofie / admin (password: password123)`);
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
