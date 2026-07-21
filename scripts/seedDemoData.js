// scripts/seedDemoData.js
//
// Full demo seed: 20 users, then 30 posts (~80% with images) by those users,
// with likes. Uses the Cloudinary manifest (generated/seedAssetManifest.json)
// for avatars and post images; falls back to a RandomUser avatar only if a
// user's manifest folder is empty. Users + posts scatter near Bergen so they
// show in Discover when you test from there.
//
//   node scripts/seedDemoData.js
//   node scripts/seedDemoData.js --lat 59.91 --lng 10.75   # Oslo instead
//   node scripts/seedDemoData.js --posts 40                # more posts
//
// Prereq: run uploadSeedAssets.js first so the manifest exists.

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import User, { snapCoords } from '../src/models/User.js';
import Post from '../src/models/Post.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MONGODB_URI = process.env.MONGO_URI;
const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD || '2255';
const MANIFEST_PATH = path.resolve(__dirname, '../generated/seedAssetManifest.json');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const CENTER_LAT = Number(arg('lat', 60.3913));
const CENTER_LNG = Number(arg('lng', 5.3221));
const NUMBER_OF_POSTS = Number(arg('posts', 30));
const IMAGE_RATIO = 0.8; // ~80% of posts get an image

const POST_TYPES = ['update', 'event', 'recommendation', 'lostfound', 'marketplace', 'question'];

// dob from age (model stores dob; age is a derived virtual). UTC, exact age.
function dobForAge(age) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() - age, now.getUTCMonth(), now.getUTCDate()));
}

const femalePhoto = (n) => ({ url: `https://randomuser.me/api/portraits/women/${n}.jpg` });
const malePhoto = (n) => ({ url: `https://randomuser.me/api/portraits/men/${n}.jpg` });

// 10 female + 10 male. `fallbackPhoto` is used only if the manifest has no
// avatar for that username. `imageCategory` on each post below must be a folder
// that exists in the manifest.
const DEMO_PROFILES = [
  { username: 'isabellexo',   email: 'isabelle@example.test', displayName: 'Isabelle', age: 25, gender: 'female', bio: 'Coffee, city walks, photography and meeting new people.', neighborhood: 'Sentrum',    fallbackPhoto: femalePhoto(44) },
  { username: 'sophiejade',   email: 'sophie@example.test',   displayName: 'Sophie',   age: 27, gender: 'female', bio: 'Designer, brunch enthusiast and weekend explorer.',       neighborhood: 'Nordnes',    fallbackPhoto: femalePhoto(47) },
  { username: 'lenaavaa',     email: 'lena@example.test',     displayName: 'Lena',     age: 24, gender: 'female', bio: 'Music, books, yoga and quiet cafés.',                     neighborhood: 'Møhlenpris', fallbackPhoto: femalePhoto(49) },
  { username: 'emiliaro',     email: 'emilia@example.test',   displayName: 'Emilia',   age: 29, gender: 'female', bio: 'Creative soul who enjoys art, food and local events.',     neighborhood: 'Sandviken',  fallbackPhoto: femalePhoto(52) },
  { username: 'noraexplores', email: 'nora@example.test',     displayName: 'Nora',     age: 26, gender: 'female', bio: 'Always looking for a new trail, view or hidden gem.',       neighborhood: 'Årstad',     fallbackPhoto: femalePhoto(55) },
  { username: 'amaliemusic',  email: 'amalie@example.test',   displayName: 'Amalie',   age: 28, gender: 'female', bio: 'Musician, concert lover and occasional songwriter.',       neighborhood: 'Landås',     fallbackPhoto: femalePhoto(58) },
  { username: 'miafit',       email: 'mia@example.test',      displayName: 'Mia',      age: 25, gender: 'female', bio: 'Running, strength training and healthy food.',             neighborhood: 'Solheim',    fallbackPhoto: femalePhoto(61) },
  { username: 'claraart',     email: 'clara@example.test',    displayName: 'Clara',    age: 30, gender: 'female', bio: 'Illustrator interested in exhibitions and local culture.', neighborhood: 'Laksevåg',   fallbackPhoto: femalePhoto(63) },
  { username: 'ellabakes',    email: 'ella@example.test',     displayName: 'Ella',     age: 26, gender: 'female', bio: 'Baking, sharing recipes and discovering local bakeries.',  neighborhood: 'Sentrum',    fallbackPhoto: femalePhoto(65) },
  { username: 'sarahlives',   email: 'sarah@example.test',    displayName: 'Sarah',    age: 28, gender: 'female', bio: 'Enjoying city life one neighborhood at a time.',           neighborhood: 'Nordnes',    fallbackPhoto: femalePhoto(68) },
  { username: 'matthewjames', email: 'matthew@example.test',  displayName: 'Matthew',  age: 29, gender: 'male',   bio: 'Coffee, football, travel and spontaneous plans.',          neighborhood: 'Sentrum',    fallbackPhoto: malePhoto(32) },
  { username: 'alexmoreno',   email: 'alex@example.test',     displayName: 'Alex',     age: 27, gender: 'male',   bio: 'Designer who enjoys food, music and city photography.',    neighborhood: 'Møhlenpris', fallbackPhoto: malePhoto(35) },
  { username: 'lukaswayfarer',email: 'lukas@example.test',    displayName: 'Lukas',    age: 31, gender: 'male',   bio: 'Hiking, travelling and searching for the best views.',     neighborhood: 'Sandviken',  fallbackPhoto: malePhoto(37) },
  { username: 'olivercodes',  email: 'oliver@example.test',   displayName: 'Oliver',   age: 28, gender: 'male',   bio: 'Developer, gamer and regular at local coffee shops.',      neighborhood: 'Årstad',     fallbackPhoto: malePhoto(39) },
  { username: 'noahfitness',  email: 'noah@example.test',     displayName: 'Noah',     age: 25, gender: 'male',   bio: 'Training, running and helping people stay active.',        neighborhood: 'Landås',     fallbackPhoto: malePhoto(41) },
  { username: 'henrikoutside',email: 'henrik@example.test',   displayName: 'Henrik',   age: 32, gender: 'male',   bio: 'Outdoors whenever possible. Hiking, skiing and cycling.',   neighborhood: 'Solheim',    fallbackPhoto: malePhoto(43) },
  { username: 'danielcreates',email: 'daniel@example.test',   displayName: 'Daniel',   age: 27, gender: 'male',   bio: 'Filmmaker interested in stories, art and collaboration.',  neighborhood: 'Laksevåg',   fallbackPhoto: malePhoto(45) },
  { username: 'williamfoodie',email: 'william@example.test',  displayName: 'William',  age: 30, gender: 'male',   bio: 'Trying restaurants and sharing local food recommendations.', neighborhood: 'Sentrum',  fallbackPhoto: malePhoto(48) },
  { username: 'theomusic',    email: 'theo@example.test',     displayName: 'Theo',     age: 26, gender: 'male',   bio: 'Guitar, live music and relaxed evenings with friends.',    neighborhood: 'Nordnes',    fallbackPhoto: malePhoto(51) },
  { username: 'jacobmoves',   email: 'jacob@example.test',    displayName: 'Jacob',    age: 29, gender: 'male',   bio: 'Dancing, movement and discovering new local activities.',  neighborhood: 'Møhlenpris', fallbackPhoto: malePhoto(53) },
];

// Each post: type, text, and an imageCategory that matches a manifest folder.
// ~80% get images; the remainder set imageCategory: null (text-only).
const DEMO_POSTS = [
  { username: 'isabellexo',    type: 'recommendation', text: 'This café has become one of my favorite places to work.', imageCategory: 'coffee' },
  { username: 'theomusic',     type: 'update',         text: 'Working on a new song this evening.',                     imageCategory: 'music' },
  { username: 'noraexplores',  type: 'recommendation', text: 'Found a beautiful walking route nearby today.',           imageCategory: 'outdoors' },
  { username: 'miafit',        type: 'event',          text: 'Beginner-friendly morning run tomorrow. All welcome.',    imageCategory: 'fitness' },
  { username: 'williamfoodie', type: 'recommendation', text: 'Highly recommend this place for a relaxed lunch.',        imageCategory: 'food' },
  { username: 'ellabakes',     type: 'update',         text: 'Fresh cinnamon rolls just came out of the oven.',         imageCategory: 'food' },
  { username: 'olivercodes',   type: 'question',       text: 'Favorite quiet café for working remotely?',              imageCategory: 'coffee' },
  { username: 'amaliemusic',   type: 'event',          text: 'Small acoustic concert this Friday evening.',            imageCategory: 'events' },
  { username: 'lukaswayfarer', type: 'update',         text: 'The evening view over the city was worth the climb.',    imageCategory: 'outdoors' },
  { username: 'claraart',      type: 'recommendation', text: 'A small local exhibition worth visiting this weekend.',  imageCategory: 'events' },
  { username: 'jacobmoves',    type: 'event',          text: 'Free outdoor dance session on Sunday afternoon.',        imageCategory: 'events' },
  { username: 'noahfitness',   type: 'question',       text: 'Any beginner-friendly running groups nearby?',          imageCategory: 'fitness' },
  { username: 'matthewjames',  type: 'update',         text: 'Slow Saturday morning with coffee and no plans.',        imageCategory: 'coffee' },
  { username: 'danielcreates', type: 'update',         text: 'Scouting locations for a small film project.',          imageCategory: 'city' },
  { username: 'sophiejade',    type: 'recommendation', text: 'The weekend market has so many good local products.',    imageCategory: 'city' },
  { username: 'sarahlives',    type: 'update',         text: 'A quiet walk by the water before sunset.',              imageCategory: 'city' },
  { username: 'henrikoutside', type: 'event',          text: 'Planning an easy weekend hike. Message me to join.',    imageCategory: 'outdoors' },
  { username: 'alexmoreno',    type: 'recommendation', text: 'Great little restaurant with a relaxed atmosphere.',    imageCategory: 'food' },
  { username: 'emiliaro',      type: 'event',          text: 'There is a neighborhood art market here on Sunday.',    imageCategory: 'events' },
  { username: 'lenaavaa',      type: 'update',         text: 'Found a peaceful corner for reading this afternoon.',   imageCategory: 'outdoors' },
  { username: 'isabellexo',    type: 'question',       text: 'Where is the best place for brunch around here?',       imageCategory: 'food' },
  { username: 'theomusic',     type: 'event',          text: 'Local musicians meeting for an informal jam session.',  imageCategory: 'music' },
  { username: 'olivercodes',   type: 'marketplace',    text: 'Selling a comfortable desk chair in good condition.',   imageCategory: 'marketplace' },
  { username: 'matthewjames',  type: 'lostfound',      text: 'Found a set of keys near the park. Message me.',        imageCategory: 'lostfound' },
  // ── text-only (imageCategory: null) — ~20% ──
  { username: 'claraart',      type: 'question',       text: 'Does anyone know a good local framing shop?',           imageCategory: null },
  { username: 'jacobmoves',    type: 'question',       text: 'Any beginner-friendly dance classes nearby?',          imageCategory: null },
  { username: 'sophiejade',    type: 'update',         text: 'Hope everyone is having a relaxed Sunday.',             imageCategory: null },
  { username: 'noraexplores',  type: 'question',       text: 'Favorite walking route in this area?',                 imageCategory: null },
  { username: 'miafit',        type: 'update',         text: 'Perfect weather for an afternoon run.',                imageCategory: null },
  { username: 'williamfoodie', type: 'update',         text: 'A slow evening and a good book.',                       imageCategory: null },
];

const PLACE_NAMES = ['Sentrum', 'Nordnes', 'Møhlenpris', 'Sandviken', 'Årstad', 'Laksevåg', 'Landås', 'Solheim'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function jitter(lat, lng, km = 5) {
  const dLat = (Math.random() - 0.5) * 2 * (km / 111);
  const dLng = (Math.random() - 0.5) * 2 * (km / (111 * Math.cos(lat * Math.PI / 180)));
  return [lng + dLng, lat + dLat];
}
function randomDateWithinLastDays(days) {
  return new Date(Date.now() - Math.floor(Math.random() * days * 24 * 60 * 60 * 1000));
}
function randomLikes(users, authorId) {
  const others = users.filter((u) => String(u._id) !== String(authorId));
  const n = Math.floor(Math.random() * 11);
  const copy = [...others];
  for (let i = copy.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy.slice(0, n).map((u) => u._id);
}

// Normalize a manifest entry ({url,publicId,...} or bare string) to {url,publicId?}.
function normImg(x) {
  if (typeof x === 'string') return { url: x };
  if (x && typeof x === 'object' && typeof x.url === 'string') return { url: x.url, ...(x.publicId ? { publicId: x.publicId } : {}) };
  return null;
}

async function loadManifest() {
  const raw = await fs.readFile(MANIFEST_PATH, 'utf8').catch(() => {
    throw new Error(`Manifest not found at ${MANIFEST_PATH}. Run uploadSeedAssets.js first.`);
  });
  const m = JSON.parse(raw);
  if (!m?.posts || !m?.avatars) throw new Error('Manifest must contain "avatars" and "posts".');
  return m;
}

async function seedUsers(passwordHash, manifest) {
  const users = [];
  for (const p of DEMO_PROFILES) {
    const existing = await User.findOne({ $or: [{ username: p.username }, { email: p.email }] });
    if (existing && existing.isSeedUser !== true) {
      throw new Error(`"${p.username}" collides with a non-demo user (${existing.email}).`);
    }
    const filter = existing ? { _id: existing._id } : { username: p.username };
    const [lng, lat] = jitter(CENTER_LAT, CENTER_LNG, 5);

    // Prefer manifest avatar(s); fall back to RandomUser if none.
    const manifestAvatars = (manifest.avatars?.[p.username] || []).map(normImg).filter(Boolean);
    const photos = manifestAvatars.length ? manifestAvatars : [p.fallbackPhoto];

    const doc = {
      username: p.username, email: p.email, displayName: p.displayName, passwordHash,
      dob: dobForAge(p.age), gender: p.gender, bio: p.bio, neighborhood: p.neighborhood,
      photos,
      profileComplete: true,
      location: { type: 'Point', coordinates: snapCoords([lng, lat]) },
      locationName: p.neighborhood, locationMode: 'manual', emailVerified: true,
      isSeedUser: true,
    };

    const user = await User.findOneAndUpdate(filter, { $set: doc },
      { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true });
    users.push(user);
    console.log(`Seeded user: ${user.username}${manifestAvatars.length ? '' : ' (fallback avatar)'}`);
  }
  console.log(`Finished seeding ${users.length} users.`);
  return users;
}

// Cycle images within a category so repeats are spread out.
function makeImagePicker(manifest) {
  const counters = new Map();
  return (category) => {
    if (!category) return '';
    const imgs = (manifest.posts?.[category] || []).map(normImg).filter(Boolean);
    if (imgs.length === 0) return ''; // category missing -> degrade to text-only
    const i = counters.get(category) ?? 0;
    counters.set(category, i + 1);
    return imgs[i % imgs.length].url;
  };
}

async function seedPosts(users, manifest) {
  const userIds = users.map((u) => u._id);
  const del = await Post.deleteMany({ author: { $in: userIds } });
  console.log(`Removed ${del.deletedCount} old posts by these users.`);

  const usersByName = new Map(users.map((u) => [u.username, u]));
  const imageFor = makeImagePicker(manifest);

  // Use the fixed DEMO_POSTS (matched text+category). If NUMBER_OF_POSTS differs
  // from the list length, cycle through the list.
  const docs = [];
  for (let i = 0; i < NUMBER_OF_POSTS; i += 1) {
    const def = DEMO_POSTS[i % DEMO_POSTS.length];
    const author = usersByName.get(def.username) || pick(users);
    const [lng, lat] = jitter(CENTER_LAT, CENTER_LNG, 5);
    const createdAt = randomDateWithinLastDays(30);
    docs.push({
      author: author._id,
      type: def.type,
      text: def.text,
      imageUrl: imageFor(def.imageCategory), // '' when null/missing category
      location: { type: 'Point', coordinates: [lng, lat] },
      placeName: pick(PLACE_NAMES),
      likes: randomLikes(users, author._id),
      createdAt, updatedAt: createdAt,
    });
  }

  let inserted = [];
  try {
    inserted = await Post.insertMany(docs, { ordered: false });
  } catch (err) {
    console.error('insertMany reported errors:');
    if (err.writeErrors) for (const we of err.writeErrors) console.error(`  index ${we.index}: ${we.errmsg || we.err?.errmsg}`);
    else console.error(err.message);
    inserted = err.insertedDocs || [];
  }
  const withImg = inserted.filter((p) => p.imageUrl).length;
  console.log(`Created ${inserted.length} posts.`);
  console.log(`With images: ${withImg} | text-only: ${inserted.length - withImg}`);
  return inserted;
}

async function run() {
  if (!MONGODB_URI) throw new Error('MONGO_URI is missing from the environment.');
  const manifest = await loadManifest();

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const users = await seedUsers(passwordHash, manifest);
  const posts = await seedPosts(users, manifest);

  console.log('');
  console.log('Demo data seed completed.');
  console.log(`Users: ${users.length}`);
  console.log(`Posts: ${posts.length}`);
  console.log(`Scatter center: [lng ${CENTER_LNG}, lat ${CENTER_LAT}] (~5km).`);
  console.log(`Demo password: ${DEMO_PASSWORD}`);
}

run()
  .catch((e) => { console.error('Demo data seed failed:', e.message); process.exitCode = 1; })
  .finally(async () => { if (mongoose.connection.readyState !== 0) await mongoose.disconnect(); });