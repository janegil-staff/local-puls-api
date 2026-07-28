// scripts/removeSeedAssets.js
//
// Deletes every Cloudinary asset belonging to the demo users:
//
//   1. Anything under localpulse/seed-assets/          (prefix scan)
//   2. Avatars referenced by demo User documents       (database)
//   3. Post images referenced by demo users' posts     (database)
//
// Then removes the now-empty seed folders (deepest-first, since Cloudinary
// only deletes empty ones) and the local manifest.
//
// RUN THIS BEFORE removeDemoData.js. Once the users and posts are deleted
// the public IDs go with them, and their Cloudinary assets become orphans
// that no script can find — they just sit there consuming quota.
//
// SAFE BY DEFAULT: without --confirm this is a DRY RUN that only lists what
// would be deleted.
//
//   node scripts/removeSeedAssets.js            # dry run (preview)
//   node scripts/removeSeedAssets.js --confirm  # actually delete
//
// NOTE ON BLAST RADIUS: categories 2 and 3 delete by public ID read from the
// database, so unlike the prefix scan they are NOT confined to a safe folder.
// Correctness depends entirely on the demo-user query below being right.
// Always read the dry run before passing --confirm.

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';

import User from '../src/models/User.js';
import Post from '../src/models/Post.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The prefix scan is confined to this. Nothing outside it is touched by
// category 1.
const ASSET_PREFIX = 'localpulse/seed-assets';

// Demo users all use @example.test emails (see seedDemoData.js). Matching on
// `email` is reliable because it is a real schema field, unlike isSeedUser
// which may not be defined in User.js — and would then be silently dropped by
// Mongoose on save, which is the usual reason { isSeedUser: true } returns [].
const DEMO_EMAIL_DOMAIN = '@example.test';

// Removed after the images are gone, DEEPEST FIRST — Cloudinary only deletes
// empty folders, so children must go before parents. The top-level
// `localpulse` folder is deliberately left alone: real user uploads live
// under it.
const FOLDERS_DEEPEST_FIRST = [
  'localpulse/seed-assets/avatars',
  'localpulse/seed-assets/posts',
  'localpulse/seed-assets',
];

const MANIFEST_PATH = path.resolve(__dirname, '../generated/seedAssetManifest.json');

const CONFIRM = process.argv.includes('--confirm');

const MONGODB_URI = process.env.MONGO_URI;

function validateEnvironment() {
  const required = [
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'MONGO_URI',
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Escape every regex metacharacter, not just the first one. String.replace
// with a string pattern only replaces the FIRST occurrence, so
// `.replace('.', '\\.')` silently leaves later dots unescaped.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Extracting public IDs from documents
// ---------------------------------------------------------------------------

// Many records store only a delivery URL, not a public ID. Recover the ID from
// the URL: everything after /upload/, minus any transformation segment and the
// version, minus the file extension.
//
//   https://res.cloudinary.com/demo/image/upload/c_fill,w_300/v1712/a/b.webp
//     -> a/b
export function publicIdFromUrl(url) {
  if (typeof url !== 'string' || !url.includes('res.cloudinary.com')) return null;

  const afterUpload = url.split('/upload/')[1];
  if (!afterUpload) return null;

  const segments = afterUpload.split('/');

  // Drop a leading transformation segment (contains a comma or starts with a
  // known transformation prefix) and the version segment (v1234567890).
  while (segments.length > 1) {
    const segment = segments[0];
    const isTransformation = segment.includes(',') || /^[a-z]{1,3}_/.test(segment);
    const isVersion = /^v\d+$/.test(segment);
    if (!isTransformation && !isVersion) break;
    segments.shift();
  }

  const withExtension = segments.join('/');
  const lastDot = withExtension.lastIndexOf('.');
  const publicId = lastDot > 0 ? withExtension.slice(0, lastDot) : withExtension;

  return publicId.split('?')[0] || null;
}

// Walks any value — string, object, array, nested — and collects anything that
// looks like a Cloudinary reference. Schemas differ between projects and
// change over time; this avoids the script silently finding nothing because a
// field is called `imageUrl` rather than `image.url`.
const ID_KEYS = ['publicId', 'public_id', 'cloudinaryId', 'cloudinary_id'];
const URL_KEYS = ['url', 'secureUrl', 'secure_url', 'imageUrl', 'src', 'path'];

function collectFromValue(value, into, depth = 0) {
  if (value == null || depth > 6) return;

  if (typeof value === 'string') {
    const fromUrl = publicIdFromUrl(value);
    if (fromUrl) into.add(fromUrl);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectFromValue(entry, into, depth + 1);
    return;
  }

  if (typeof value !== 'object') return;
  if (value instanceof Date || value instanceof mongoose.Types.ObjectId) return;

  for (const [key, nested] of Object.entries(value)) {
    if (ID_KEYS.includes(key) && typeof nested === 'string' && nested.trim()) {
      into.add(nested.trim());
      continue;
    }
    if (URL_KEYS.includes(key) && typeof nested === 'string') {
      const fromUrl = publicIdFromUrl(nested);
      if (fromUrl) into.add(fromUrl);
      continue;
    }
    collectFromValue(nested, into, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function findDemoUsers() {
  const query = {
    $or: [
      {
        email: {
          $regex: `${escapeRegex(DEMO_EMAIL_DOMAIN)}$`,
          $options: 'i',
        },
      },
      { isSeedUser: true },
    ],
  };

  return User.find(query).lean();
}

// Category 1: everything under the seed prefix, paginating past the
// 500-per-call limit via next_cursor.
async function collectFromPrefix() {
  const publicIds = new Set();
  let nextCursor;

  do {
    const response = await cloudinary.api.resources({
      type: 'upload',
      prefix: ASSET_PREFIX,
      max_results: 500,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    });

    for (const resource of response.resources ?? []) {
      // Extra guard: never include anything outside the prefix.
      if (resource.public_id?.startsWith(ASSET_PREFIX)) {
        publicIds.add(resource.public_id);
      }
    }

    nextCursor = response.next_cursor;
  } while (nextCursor);

  return publicIds;
}

// Category 2: avatars and any other imagery on the User documents themselves.
function collectFromUsers(users) {
  const publicIds = new Set();
  for (const user of users) collectFromValue(user, publicIds);
  return publicIds;
}

// Category 3: images on posts authored by demo users.
async function collectFromPosts(userIds) {
  const publicIds = new Set();
  if (userIds.length === 0) return { publicIds, postCount: 0 };

  const posts = await Post.find({ author: { $in: userIds } }).lean();
  for (const post of posts) collectFromValue(post, publicIds);

  return { publicIds, postCount: posts.length };
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

// delete_resources accepts up to 100 public IDs per call.
async function deleteInBatches(publicIds, resourceType) {
  let deleted = 0;
  let notFound = 0;

  for (let i = 0; i < publicIds.length; i += 100) {
    const batch = publicIds.slice(i, i + 100);
    const result = await cloudinary.api.delete_resources(batch, {
      type: 'upload',
      resource_type: resourceType,
      invalidate: true,
    });

    // result.deleted maps publicId -> "deleted" | "not_found".
    for (const value of Object.values(result.deleted ?? {})) {
      if (value === 'deleted') deleted += 1;
      else notFound += 1;
    }
  }

  return { deleted, notFound };
}

async function deleteFolders() {
  let removed = 0;

  for (const folder of FOLDERS_DEEPEST_FIRST) {
    try {
      await cloudinary.api.delete_folder(folder);
      console.log(`  Deleted folder: ${folder}`);
      removed += 1;
    } catch (error) {
      // Missing or not yet empty. Report and continue rather than aborting.
      const message = error?.error?.message || error?.message || String(error);
      console.log(`  Skipped folder ${folder}: ${message}`);
    }
  }

  return removed;
}

async function deleteManifest() {
  try {
    await fs.unlink(MANIFEST_PATH);
    console.log(`Deleted manifest: ${MANIFEST_PATH}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('Manifest already absent — nothing to delete.');
      return false;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------

async function run() {
  validateEnvironment();

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.\n');

  const demoUsers = await findDemoUsers();
  const userIds = demoUsers.map((user) => user._id);

  console.log(`Demo users: ${demoUsers.length}`);
  for (const user of demoUsers) {
    console.log(`  ${user.username ?? '(no username)'} <${user.email}>`);
  }
  console.log('');

  console.log(`Scanning Cloudinary prefix "${ASSET_PREFIX}"...`);
  const fromPrefix = await collectFromPrefix();
  console.log(`  ${fromPrefix.size} asset(s)`);

  console.log('Reading avatars from demo user documents...');
  const fromUsers = collectFromUsers(demoUsers);
  console.log(`  ${fromUsers.size} asset(s)`);

  console.log('Reading images from demo users\' posts...');
  const { publicIds: fromPosts, postCount } = await collectFromPosts(userIds);
  console.log(`  ${fromPosts.size} asset(s) across ${postCount} post(s)`);

  // Union — an asset may appear in more than one source.
  const all = new Set([...fromPrefix, ...fromUsers, ...fromPosts]);
  const outsidePrefix = [...all].filter((id) => !id.startsWith(ASSET_PREFIX));

  console.log(`\nTotal unique assets: ${all.size}`);
  if (outsidePrefix.length > 0) {
    console.log(
      `  ${outsidePrefix.length} of these live OUTSIDE "${ASSET_PREFIX}" — ` +
        'they were uploaded by demo users through the app, not by the seed script.'
    );
  }

  if (!CONFIRM) {
    console.log('\nDRY RUN — nothing will be deleted. Pass --confirm to delete.\n');

    for (const id of [...all].sort()) {
      const flag = id.startsWith(ASSET_PREFIX) ? '  ' : '! ';
      console.log(`  ${flag}would delete: ${id}`);
    }

    if (outsidePrefix.length > 0) {
      console.log('\n  Lines marked ! are outside the seed prefix. Read them before confirming.');
    }

    console.log(`\nWould also remove folders: ${FOLDERS_DEEPEST_FIRST.join(', ')}`);
    console.log(`Would also remove manifest: ${MANIFEST_PATH}`);
    console.log('\nAfter this, run: node scripts/removeDemoData.js');
    return;
  }

  const ids = [...all];
  let images = { deleted: 0, notFound: 0 };
  let videos = { deleted: 0, notFound: 0 };

  if (ids.length > 0) {
    console.log('\nDeleting images...');
    images = await deleteInBatches(ids, 'image');

    // Anything not found as an image may be a video. Cheap to try, and posts
    // with video attachments would otherwise be left behind.
    if (images.notFound > 0) {
      console.log('Retrying not-found IDs as video...');
      videos = await deleteInBatches(ids, 'video');
    }
  }

  console.log('Deleting folders...');
  const deletedFolders = await deleteFolders();

  console.log('Removing local manifest...');
  const manifestRemoved = await deleteManifest();

  console.log('');
  console.log(`Images deleted  : ${images.deleted}`);
  console.log(`Videos deleted  : ${videos.deleted}`);
  console.log(`Not found       : ${images.notFound - videos.deleted}`);
  console.log(`Folders deleted : ${deletedFolders}`);
  console.log(
    manifestRemoved
      ? 'Manifest        : deleted'
      : 'Manifest        : already absent'
  );
  console.log('\nNext: node scripts/removeDemoData.js');
}

run()
  .catch((error) => {
    console.error('Remove seed assets failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });