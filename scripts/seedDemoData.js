// scripts/seedDemoData.js

import 'dotenv/config';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Post from '../src/models/Post.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MONGODB_URI = process.env.MONGO_URI;

const DEMO_PASSWORD =
  process.env.DEMO_USER_PASSWORD || 'Demo1234!';

const MANIFEST_PATH = path.resolve(
  __dirname,
  '../generated/seedAssetManifest.json',
);

/**
 * These must match POST_TYPES in:
 * src/models/Post.js
 */
const VALID_POST_TYPES = new Set([
  'update',
  'event',
  'recommendation',
  'lostfound',
  'marketplace',
  'question',
]);

const DEMO_PROFILES = [
  {
    username: 'isabellexo',
    email: 'isabelle@example.test',
    displayName: 'Isabelle Larsen',
    age: 25,
    gender: 'female',
    bio: 'Coffee, city walks, photography and meeting new people.',
    neighborhood: 'Grünerløkka',
  },
  {
    username: 'sophiejade',
    email: 'sophie@example.test',
    displayName: 'Sophie Berg',
    age: 27,
    gender: 'female',
    bio: 'Designer, brunch enthusiast and weekend explorer.',
    neighborhood: 'Frogner',
  },
  {
    username: 'lenaavaa',
    email: 'lena@example.test',
    displayName: 'Lena Hansen',
    age: 24,
    gender: 'female',
    bio: 'Music, books, yoga and quiet cafés.',
    neighborhood: 'St. Hanshaugen',
  },
  {
    username: 'emiliaro',
    email: 'emilia@example.test',
    displayName: 'Emilia Røed',
    age: 29,
    gender: 'female',
    bio: 'Creative soul who enjoys art, food and local events.',
    neighborhood: 'Tøyen',
  },
  {
    username: 'noraexplores',
    email: 'nora@example.test',
    displayName: 'Nora Eriksen',
    age: 26,
    gender: 'female',
    bio: 'Always looking for a new trail, view or hidden gem.',
    neighborhood: 'Sagene',
  },
  {
    username: 'amaliemusic',
    email: 'amalie@example.test',
    displayName: 'Amalie Solberg',
    age: 28,
    gender: 'female',
    bio: 'Musician, concert lover and occasional songwriter.',
    neighborhood: 'Majorstuen',
  },
  {
    username: 'miafit',
    email: 'mia@example.test',
    displayName: 'Mia Kristiansen',
    age: 25,
    gender: 'female',
    bio: 'Running, strength training and healthy food.',
    neighborhood: 'Bislett',
  },
  {
    username: 'claraart',
    email: 'clara@example.test',
    displayName: 'Clara Nilsen',
    age: 30,
    gender: 'female',
    bio: 'Illustrator interested in exhibitions and local culture.',
    neighborhood: 'Gamle Oslo',
  },
  {
    username: 'ellabakes',
    email: 'ella@example.test',
    displayName: 'Ella Johansen',
    age: 26,
    gender: 'female',
    bio: 'Baking, sharing recipes and discovering local bakeries.',
    neighborhood: 'Bjørvika',
  },
  {
    username: 'sarahlives',
    email: 'sarah@example.test',
    displayName: 'Sarah Lie',
    age: 28,
    gender: 'female',
    bio: 'Enjoying city life one neighborhood at a time.',
    neighborhood: 'Aker Brygge',
  },
  {
    username: 'matthewjames',
    email: 'matthew@example.test',
    displayName: 'Matthew James',
    age: 29,
    gender: 'male',
    bio: 'Coffee, football, travel and spontaneous plans.',
    neighborhood: 'Grünerløkka',
  },
  {
    username: 'alexmoreno',
    email: 'alex@example.test',
    displayName: 'Alex Moreno',
    age: 27,
    gender: 'male',
    bio: 'Designer who enjoys food, music and city photography.',
    neighborhood: 'Frogner',
  },
  {
    username: 'lukaswayfarer',
    email: 'lukas@example.test',
    displayName: 'Lukas Andersen',
    age: 31,
    gender: 'male',
    bio: 'Hiking, travelling and searching for the best views.',
    neighborhood: 'St. Hanshaugen',
  },
  {
    username: 'olivercodes',
    email: 'oliver@example.test',
    displayName: 'Oliver Dahl',
    age: 28,
    gender: 'male',
    bio: 'Developer, gamer and regular at local coffee shops.',
    neighborhood: 'Tøyen',
  },
  {
    username: 'noahfitness',
    email: 'noah@example.test',
    displayName: 'Noah Strand',
    age: 25,
    gender: 'male',
    bio: 'Training, running and helping people stay active.',
    neighborhood: 'Bislett',
  },
  {
    username: 'henrikoutside',
    email: 'henrik@example.test',
    displayName: 'Henrik Moe',
    age: 32,
    gender: 'male',
    bio: 'Outdoors whenever possible. Hiking, skiing and cycling.',
    neighborhood: 'Sagene',
  },
  {
    username: 'danielcreates',
    email: 'daniel@example.test',
    displayName: 'Daniel Hagen',
    age: 27,
    gender: 'male',
    bio: 'Filmmaker interested in stories, art and collaboration.',
    neighborhood: 'Gamle Oslo',
  },
  {
    username: 'williamfoodie',
    email: 'william@example.test',
    displayName: 'William Lund',
    age: 30,
    gender: 'male',
    bio: 'Trying restaurants and sharing local food recommendations.',
    neighborhood: 'Bjørvika',
  },
  {
    username: 'theomusic',
    email: 'theo@example.test',
    displayName: 'Theo Karlsen',
    age: 26,
    gender: 'male',
    bio: 'Guitar, live music and relaxed evenings with friends.',
    neighborhood: 'Majorstuen',
  },
  {
    username: 'jacobmoves',
    email: 'jacob@example.test',
    displayName: 'Jacob Eide',
    age: 29,
    gender: 'male',
    bio: 'Dancing, movement and discovering new local activities.',
    neighborhood: 'Aker Brygge',
  },
];

/**
 * GeoJSON coordinates must be:
 *
 * [longitude, latitude]
 */
const PLACES = {
  grunerlokka: {
    placeName: 'Grünerløkka',
    coordinates: [10.7582, 59.9238],
  },
  frogner: {
    placeName: 'Frogner',
    coordinates: [10.7067, 59.9177],
  },
  majorstuen: {
    placeName: 'Majorstuen',
    coordinates: [10.7131, 59.9295],
  },
  stHanshaugen: {
    placeName: 'St. Hanshaugen',
    coordinates: [10.7395, 59.927],
  },
  sagene: {
    placeName: 'Sagene',
    coordinates: [10.7511, 59.9387],
  },
  toyen: {
    placeName: 'Tøyen',
    coordinates: [10.7741, 59.9143],
  },
  bjorvika: {
    placeName: 'Bjørvika',
    coordinates: [10.7551, 59.9075],
  },
  gamleOslo: {
    placeName: 'Gamle Oslo',
    coordinates: [10.781, 59.9067],
  },
  bislett: {
    placeName: 'Bislett',
    coordinates: [10.7339, 59.925],
  },
  akerBrygge: {
    placeName: 'Aker Brygge',
    coordinates: [10.7273, 59.9105],
  },
};

/**
 * 30 fixed posts.
 *
 * 27 use images.
 * 3 are text-only.
 *
 * imageCategory must match a folder under:
 * seed-assets/posts/
 */
const DEMO_POSTS = [
  {
    username: 'isabellexo',
    type: 'recommendation',
    text: 'This café has become one of my favorite places to work.',
    imageCategory: 'coffee',
    ...PLACES.grunerlokka,
  },
  {
    username: 'theomusic',
    type: 'update',
    text: 'Working on a new song this evening.',
    imageCategory: 'music',
    ...PLACES.majorstuen,
  },
  {
    username: 'noraexplores',
    type: 'recommendation',
    text: 'Found a beautiful walking route along Akerselva today.',
    imageCategory: 'outdoors',
    ...PLACES.sagene,
  },
  {
    username: 'miafit',
    type: 'event',
    text: 'Beginner-friendly morning run tomorrow. Everyone is welcome.',
    imageCategory: 'fitness',
    ...PLACES.bislett,
  },
  {
    username: 'williamfoodie',
    type: 'recommendation',
    text: 'Highly recommend this place for a relaxed weekend lunch.',
    imageCategory: 'food',
    ...PLACES.bjorvika,
  },
  {
    username: 'ellabakes',
    type: 'update',
    text: 'Fresh cinnamon rolls just came out of the oven.',
    imageCategory: 'food',
    ...PLACES.bjorvika,
  },
  {
    username: 'olivercodes',
    type: 'question',
    text: 'What is your favorite quiet café for working remotely?',
    imageCategory: 'coffee',
    ...PLACES.toyen,
  },
  {
    username: 'amaliemusic',
    type: 'event',
    text: 'Small acoustic concert this Friday evening.',
    imageCategory: 'events',
    ...PLACES.majorstuen,
  },
  {
    username: 'lukaswayfarer',
    type: 'update',
    text: 'The evening view over the city was worth the climb.',
    imageCategory: 'outdoors',
    ...PLACES.stHanshaugen,
  },
  {
    username: 'claraart',
    type: 'recommendation',
    text: 'A small local exhibition worth visiting this weekend.',
    imageCategory: 'events',
    ...PLACES.gamleOslo,
  },
  {
    username: 'jacobmoves',
    type: 'event',
    text: 'Free outdoor dance session on Sunday afternoon.',
    imageCategory: 'events',
    ...PLACES.akerBrygge,
  },
  {
    username: 'noahfitness',
    type: 'question',
    text: 'Are there any beginner-friendly running groups nearby?',
    imageCategory: 'fitness',
    ...PLACES.bislett,
  },
  {
    username: 'matthewjames',
    type: 'update',
    text: 'Slow Saturday morning with coffee and no plans.',
    imageCategory: 'coffee',
    ...PLACES.grunerlokka,
  },
  {
    username: 'danielcreates',
    type: 'update',
    text: 'Scouting locations for a small film project.',
    imageCategory: 'city',
    ...PLACES.gamleOslo,
  },
  {
    username: 'sophiejade',
    type: 'recommendation',
    text: 'The weekend market has so many good local products.',
    imageCategory: 'city',
    ...PLACES.frogner,
  },
  {
    username: 'sarahlives',
    type: 'update',
    text: 'A quiet walk by the water before sunset.',
    imageCategory: 'city',
    ...PLACES.akerBrygge,
  },
  {
    username: 'henrikoutside',
    type: 'event',
    text: 'Planning an easy weekend hike. Message me if you want to join.',
    imageCategory: 'outdoors',
    ...PLACES.sagene,
  },
  {
    username: 'alexmoreno',
    type: 'recommendation',
    text: 'Great little restaurant with a relaxed atmosphere.',
    imageCategory: 'food',
    ...PLACES.frogner,
  },
  {
    username: 'emiliaro',
    type: 'event',
    text: 'There is a neighborhood art market here on Sunday.',
    imageCategory: 'events',
    ...PLACES.toyen,
  },
  {
    username: 'lenaavaa',
    type: 'update',
    text: 'Found a peaceful corner for reading this afternoon.',
    imageCategory: 'outdoors',
    ...PLACES.stHanshaugen,
  },
  {
    username: 'isabellexo',
    type: 'question',
    text: 'Where is the best place for brunch around here?',
    imageCategory: 'food',
    ...PLACES.grunerlokka,
  },
  {
    username: 'theomusic',
    type: 'event',
    text: 'A few local musicians are meeting for an informal jam session.',
    imageCategory: 'music',
    ...PLACES.majorstuen,
  },
  {
    username: 'miafit',
    type: 'update',
    text: 'Perfect weather for an afternoon run.',
    imageCategory: 'fitness',
    ...PLACES.bislett,
  },
  {
    username: 'williamfoodie',
    type: 'recommendation',
    text: 'The pastries here are absolutely worth trying.',
    imageCategory: 'food',
    ...PLACES.bjorvika,
  },
  {
    username: 'noraexplores',
    type: 'question',
    text: 'What is your favorite walking route in this area?',
    imageCategory: 'outdoors',
    ...PLACES.sagene,
  },
  {
    username: 'olivercodes',
    type: 'marketplace',
    text: 'Selling a comfortable desk chair in good condition.',
    imageCategory: 'marketplace',
    ...PLACES.toyen,
  },
  {
    username: 'matthewjames',
    type: 'lostfound',
    text: 'Found a set of keys near the park. Message me if they might be yours.',
    imageCategory: 'lostfound',
    ...PLACES.grunerlokka,
  },

  // Text-only post 1
  {
    username: 'claraart',
    type: 'question',
    text: 'Does anyone know a good local framing shop?',
    imageCategory: null,
    ...PLACES.gamleOslo,
  },

  // Text-only post 2
  {
    username: 'jacobmoves',
    type: 'question',
    text: 'Are there any beginner-friendly dance classes nearby?',
    imageCategory: null,
    ...PLACES.akerBrygge,
  },

  // Text-only post 3
  {
    username: 'sophiejade',
    type: 'update',
    text: 'Hope everyone is having a relaxed Sunday.',
    imageCategory: null,
    ...PLACES.frogner,
  },
];

function assertEnvironment() {
  if (!MONGODB_URI) {
    throw new Error(
      'MONGO_URI is missing from your environment.',
    );
  }
}

async function loadAssetManifest() {
  let fileContents;

  try {
    fileContents = await fs.readFile(
      MANIFEST_PATH,
      'utf8',
    );
  } catch (error) {
    throw new Error(
      [
        `Could not read the seed asset manifest:`,
        MANIFEST_PATH,
        '',
        'Run this first:',
        'node scripts/uploadSeedAssets.js',
        '',
        `Original error: ${error.message}`,
      ].join('\n'),
    );
  }

  let manifest;

  try {
    manifest = JSON.parse(fileContents);
  } catch (error) {
    throw new Error(
      `The seed asset manifest contains invalid JSON: ${error.message}`,
    );
  }

  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !manifest.avatars ||
    !manifest.posts
  ) {
    throw new Error(
      'The seed asset manifest must contain "avatars" and "posts" objects.',
    );
  }

  return manifest;
}

function validateDemoConfiguration() {
  const usernames = new Set();

  for (const profile of DEMO_PROFILES) {
    if (usernames.has(profile.username)) {
      throw new Error(
        `Duplicate demo username: ${profile.username}`,
      );
    }

    usernames.add(profile.username);
  }

  for (const post of DEMO_POSTS) {
    if (!usernames.has(post.username)) {
      throw new Error(
        `Post references unknown user: ${post.username}`,
      );
    }

    if (!VALID_POST_TYPES.has(post.type)) {
      throw new Error(
        `Invalid post type "${post.type}" for ${post.username}.`,
      );
    }

    if (
      !Array.isArray(post.coordinates) ||
      post.coordinates.length !== 2 ||
      !post.coordinates.every(Number.isFinite)
    ) {
      throw new Error(
        `Invalid coordinates for post by ${post.username}.`,
      );
    }
  }
}

function normalizeManifestImage(image) {
  if (typeof image === 'string') {
    return {
      url: image,
    };
  }

  if (
    image &&
    typeof image === 'object' &&
    typeof image.url === 'string'
  ) {
    return {
      url: image.url,
      ...(image.publicId
        ? { publicId: image.publicId }
        : {}),
    };
  }

  return null;
}

function getProfilePhotos({
  manifest,
  username,
}) {
  const rawImages =
    manifest.avatars?.[username] ?? [];

  const images = rawImages
    .map(normalizeManifestImage)
    .filter(Boolean);

  if (images.length === 0) {
    throw new Error(
      [
        `No avatar images found for "${username}".`,
        '',
        `Expected image files inside:`,
        `seed-assets/avatars/${username}/`,
        '',
        'Upload the assets again after adding the images.',
      ].join('\n'),
    );
  }

  return images;
}

function validateManifestAssets(manifest) {
  const errors = [];

  for (const profile of DEMO_PROFILES) {
    const images =
      manifest.avatars?.[profile.username] ?? [];

    if (!Array.isArray(images) || images.length === 0) {
      errors.push(
        `Missing avatar: avatars/${profile.username}`,
      );
    }
  }

  const requiredPostCategories = new Set(
    DEMO_POSTS
      .map((post) => post.imageCategory)
      .filter(Boolean),
  );

  for (const category of requiredPostCategories) {
    const images =
      manifest.posts?.[category] ?? [];

    if (!Array.isArray(images) || images.length === 0) {
      errors.push(
        `Missing post category: posts/${category}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      [
        'The asset manifest is missing required images:',
        '',
        ...errors.map((error) => `- ${error}`),
        '',
        'Add the missing files and run:',
        'node scripts/uploadSeedAssets.js',
      ].join('\n'),
    );
  }
}

function buildUserData({
  profile,
  passwordHash,
  manifest,
}) {
  return {
    username: profile.username,
    email: profile.email,
    displayName: profile.displayName,
    passwordHash,
    age: profile.age,
    gender: profile.gender,
    bio: profile.bio,
    neighborhood: profile.neighborhood,

    photos: getProfilePhotos({
      manifest,
      username: profile.username,
    }),

    isSeedUser: true,
  };
}

async function seedUsers({
  manifest,
}) {
  const passwordHash = await bcrypt.hash(
    DEMO_PASSWORD,
    12,
  );

  const users = [];

  for (const profile of DEMO_PROFILES) {
    const existingUser = await User.findOne({
      $or: [
        { username: profile.username },
        { email: profile.email },
      ],
    });

    if (
      existingUser &&
      existingUser.isSeedUser !== true
    ) {
      throw new Error(
        [
          `Cannot seed "${profile.username}".`,
          'Its username or email is already used by a non-demo user.',
          '',
          `Existing username: ${existingUser.username}`,
          `Existing email: ${existingUser.email}`,
        ].join('\n'),
      );
    }

    const filter = existingUser
      ? { _id: existingUser._id }
      : { username: profile.username };

    const user = await User.findOneAndUpdate(
      filter,
      {
        $set: buildUserData({
          profile,
          passwordHash,
          manifest,
        }),
      },
      {
        upsert: true,
        returnDocument: 'after',
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    users.push(user);

    console.log(
      `Seeded user: ${user.username}`,
    );
  }

  console.log(
    `Finished seeding ${users.length} users.`,
  );

  return users;
}

function getImageUrl({
  manifest,
  category,
  categoryCounters,
}) {
  if (!category) {
    return '';
  }

  const rawImages =
    manifest.posts?.[category] ?? [];

  const images = rawImages
    .map(normalizeManifestImage)
    .filter(Boolean);

  if (images.length === 0) {
    throw new Error(
      `No usable post images found for category "${category}".`,
    );
  }

  const currentIndex =
    categoryCounters.get(category) ?? 0;

  const selectedImage =
    images[currentIndex % images.length];

  categoryCounters.set(
    category,
    currentIndex + 1,
  );

  return selectedImage.url;
}

function randomDateWithinLastDays(days) {
  const millisecondsPerDay =
    24 * 60 * 60 * 1000;

  const maximumOffset =
    days * millisecondsPerDay;

  return new Date(
    Date.now() -
      Math.floor(Math.random() * maximumOffset),
  );
}

function shuffledCopy(items) {
  const copy = [...items];

  for (
    let index = copy.length - 1;
    index > 0;
    index -= 1
  ) {
    const randomIndex = Math.floor(
      Math.random() * (index + 1),
    );

    [copy[index], copy[randomIndex]] = [
      copy[randomIndex],
      copy[index],
    ];
  }

  return copy;
}

function createRandomLikes({
  users,
  authorId,
}) {
  const candidates = users.filter(
    (user) =>
      String(user._id) !== String(authorId),
  );

  /**
   * Creates between 0 and 10 likes.
   */
  const likeCount = Math.floor(
    Math.random() * 11,
  );

  return shuffledCopy(candidates)
    .slice(0, likeCount)
    .map((user) => user._id);
}

function buildPostDocuments({
  users,
  manifest,
}) {
  const usersByUsername = new Map(
    users.map((user) => [
      user.username,
      user,
    ]),
  );

  const categoryCounters = new Map();

  return DEMO_POSTS.map(
    (definition) => {
      const author = usersByUsername.get(
        definition.username,
      );

      if (!author) {
        throw new Error(
          `Could not find seeded author "${definition.username}".`,
        );
      }

      const createdAt =
        randomDateWithinLastDays(30);

      return {
        author: author._id,
        type: definition.type,
        text: definition.text,

        imageUrl: getImageUrl({
          manifest,
          category:
            definition.imageCategory,
          categoryCounters,
        }),

        location: {
          type: 'Point',
          coordinates:
            definition.coordinates,
        },

        placeName: definition.placeName,

        likes: createRandomLikes({
          users,
          authorId: author._id,
        }),

        createdAt,
        updatedAt: createdAt,
      };
    },
  );
}

async function removeExistingDemoPosts(users) {
  const userIds = users.map(
    (user) => user._id,
  );

  const result = await Post.deleteMany({
    author: {
      $in: userIds,
    },
  });

  console.log(
    `Removed ${result.deletedCount} old demo posts.`,
  );
}

async function seedPosts({
  users,
  manifest,
}) {
  await removeExistingDemoPosts(users);

  const postDocuments =
    buildPostDocuments({
      users,
      manifest,
    });

  const posts = await Post.insertMany(
    postDocuments,
  );

  const postsWithImages = posts.filter(
    (post) => Boolean(post.imageUrl),
  ).length;

  console.log(
    `Created ${posts.length} demo posts.`,
  );

  console.log(
    `Posts with images: ${postsWithImages}`,
  );

  console.log(
    `Text-only posts: ${
      posts.length - postsWithImages
    }`,
  );

  return posts;
}

async function seedDemoData() {
  assertEnvironment();
  validateDemoConfiguration();

  const manifest =
    await loadAssetManifest();

  validateManifestAssets(manifest);

  await mongoose.connect(MONGODB_URI);

  console.log('Connected to MongoDB.');

  const users = await seedUsers({
    manifest,
  });

  const posts = await seedPosts({
    users,
    manifest,
  });

  console.log('');
  console.log('Demo data seed completed.');
  console.log(`Users: ${users.length}`);
  console.log(`Posts: ${posts.length}`);
  console.log(
    `Demo password: ${DEMO_PASSWORD}`,
  );
}

seedDemoData()
  .catch((error) => {
    console.error('');
    console.error(
      'Demo data seed failed:',
    );

    console.error(
      error instanceof Error
        ? error.message
        : error,
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });