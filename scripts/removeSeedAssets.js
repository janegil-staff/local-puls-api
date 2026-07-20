// scripts/removeSeedAssets.js
//
// Deletes all Cloudinary seed assets under localpulse/seed-assets/, removes the
// now-empty folders (deepest-first, since Cloudinary only deletes empty ones),
// and removes the local manifest at generated/seedAssetManifest.json.
//
// SAFE BY DEFAULT: without --confirm it is a DRY RUN that only lists what would
// be deleted. It ONLY touches public IDs beginning with the prefix below, so it
// can never remove real user uploads that live elsewhere.
//
//   node scripts/removeSeedAssets.js            # dry run (preview)
//   node scripts/removeSeedAssets.js --confirm  # actually delete

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v2 as cloudinary } from 'cloudinary';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Everything we delete must start with this. Nothing outside it is touched.
const ASSET_PREFIX = 'localpulse/seed-assets';

// Folders to remove after the images are gone, DEEPEST FIRST. Cloudinary only
// deletes empty folders, so children must go before parents. We intentionally
// do NOT delete the top-level `localpulse` folder, since other real assets
// (e.g. user uploads, seed-users) may live under it.
const FOLDERS_DEEPEST_FIRST = [
  'localpulse/seed-assets/avatars',
  'localpulse/seed-assets/posts',
  'localpulse/seed-assets',
];

const MANIFEST_PATH = path.resolve(
  __dirname,
  '../generated/seedAssetManifest.json',
);

const CONFIRM = process.argv.includes('--confirm');

function validateEnvironment() {
  const required = [
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
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

// Collect every public_id under the prefix, paginating past the 500-per-call
// limit via next_cursor.
async function collectAllPublicIds() {
  const publicIds = [];
  let nextCursor;

  do {
    const response = await cloudinary.api.resources({
      type: 'upload',
      prefix: ASSET_PREFIX,
      max_results: 500,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    });

    for (const resource of response.resources ?? []) {
      // Extra guard: never include anything that doesn't start with the prefix.
      if (resource.public_id?.startsWith(ASSET_PREFIX)) {
        publicIds.push(resource.public_id);
      }
    }

    nextCursor = response.next_cursor;
  } while (nextCursor);

  return publicIds;
}

// delete_resources accepts up to 100 public IDs per call, so batch it.
async function deleteInBatches(publicIds) {
  let deleted = 0;

  for (let i = 0; i < publicIds.length; i += 100) {
    const batch = publicIds.slice(i, i + 100);
    const result = await cloudinary.api.delete_resources(batch, {
      type: 'upload',
      resource_type: 'image',
      invalidate: true,
    });

    // result.deleted is a map of publicId -> "deleted" | "not_found".
    const outcomes = result.deleted ?? {};
    for (const value of Object.values(outcomes)) {
      if (value === 'deleted') deleted += 1;
    }
  }

  return deleted;
}

async function deleteFolders() {
  let removed = 0;

  for (const folder of FOLDERS_DEEPEST_FIRST) {
    try {
      await cloudinary.api.delete_folder(folder);
      console.log(`  Deleted folder: ${folder}`);
      removed += 1;
    } catch (error) {
      // Folder may be missing or not yet empty; report and continue rather
      // than aborting the whole cleanup.
      const msg = error?.error?.message || error?.message || String(error);
      console.log(`  Skipped folder ${folder}: ${msg}`);
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

async function run() {
  validateEnvironment();

  console.log(
    `Scanning Cloudinary for assets under "${ASSET_PREFIX}"...`,
  );
  const publicIds = await collectAllPublicIds();
  console.log(`Found ${publicIds.length} image(s).`);

  if (!CONFIRM) {
    console.log('');
    console.log('DRY RUN — nothing will be deleted. Pass --confirm to delete.');
    console.log('');
    for (const id of publicIds) console.log(`  would delete: ${id}`);
    console.log('');
    console.log(`Would also remove folders: ${FOLDERS_DEEPEST_FIRST.join(', ')}`);
    console.log(`Would also remove manifest: ${MANIFEST_PATH}`);
    return;
  }

  let deletedImages = 0;
  if (publicIds.length > 0) {
    console.log('Deleting images...');
    deletedImages = await deleteInBatches(publicIds);
  }

  console.log('Deleting folders...');
  const deletedFolders = await deleteFolders();

  console.log('Removing local manifest...');
  const manifestRemoved = await deleteManifest();

  console.log('');
  console.log(`Deleted ${deletedImages} image(s).`);
  console.log(`Deleted ${deletedFolders} folder(s).`);
  console.log(
    manifestRemoved
      ? 'Deleted generated/seedAssetManifest.json'
      : 'No manifest to delete.',
  );
  console.log('Done.');
}

run().catch((error) => {
  console.error('Remove seed assets failed:', error?.message || error);
  process.exitCode = 1;
});