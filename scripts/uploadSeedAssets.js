// scripts/uploadSeedAssets.js

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v2 as cloudinary } from 'cloudinary';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ASSET_ROOT = path.join(PROJECT_ROOT, 'seed-assets');
const OUTPUT_DIRECTORY = path.join(
  PROJECT_ROOT,
  'generated',
);
const OUTPUT_FILE = path.join(
  OUTPUT_DIRECTORY,
  'seedAssetManifest.json',
);

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
]);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function validateEnvironment() {
  const requiredVariables = [
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
  ];

  const missingVariables = requiredVariables.filter(
    (name) => !process.env[name],
  );

  if (missingVariables.length > 0) {
    throw new Error(
      `Missing environment variables: ${missingVariables.join(
        ', ',
      )}`,
    );
  }
}

function normalizePathSegment(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-');
}

async function directoryExists(directoryPath) {
  try {
    const stats = await fs.stat(directoryPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function collectImageFiles(directoryPath) {
  const entries = await fs.readdir(directoryPath, {
    withFileTypes: true,
  });

  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(
      directoryPath,
      entry.name,
    );

    if (entry.isDirectory()) {
      const nestedFiles =
        await collectImageFiles(fullPath);

      files.push(...nestedFiles);
      continue;
    }

    const extension = path
      .extname(entry.name)
      .toLowerCase();

    if (SUPPORTED_EXTENSIONS.has(extension)) {
      files.push(fullPath);
    }
  }

  return files;
}

function createManifestPath(filePath) {
  const relativePath = path.relative(
    ASSET_ROOT,
    filePath,
  );

  const parsed = path.parse(relativePath);

  return {
    relativePath,
    segments: parsed.dir
      .split(path.sep)
      .filter(Boolean),
    filename: parsed.name,
  };
}

function assignManifestValue({
  manifest,
  segments,
  value,
}) {
  let current = manifest;

  for (const segment of segments) {
    if (!current[segment]) {
      current[segment] = [];
    }

    if (Array.isArray(current[segment])) {
      current[segment].push(value);
      return;
    }

    current = current[segment];
  }
}

async function uploadImage(filePath) {
  const {
    relativePath,
    segments,
    filename,
  } = createManifestPath(filePath);

  const cloudinaryFolder = [
    'localpulse',
    'seed-assets',
    ...segments.map(normalizePathSegment),
  ].join('/');

  const publicId = normalizePathSegment(filename);

  console.log(`Uploading ${relativePath}`);

  const result = await cloudinary.uploader.upload(
    filePath,
    {
      folder: cloudinaryFolder,
      public_id: publicId,
      overwrite: true,
      resource_type: 'image',
      transformation: [
        {
          quality: 'auto',
          fetch_format: 'auto',
        },
      ],
    },
  );

  return {
    url: result.secure_url,
    publicId: result.public_id,
    width: result.width,
    height: result.height,
  };
}

async function uploadSeedAssets() {
  validateEnvironment();

  if (!(await directoryExists(ASSET_ROOT))) {
    throw new Error(
      `Seed asset directory does not exist: ${ASSET_ROOT}`,
    );
  }

  const files = await collectImageFiles(ASSET_ROOT);

  if (files.length === 0) {
    throw new Error(
      `No image files found inside ${ASSET_ROOT}`,
    );
  }

  console.log(
    `Found ${files.length} seed images.`,
  );

  const manifest = {
    avatars: {},
    posts: {},
  };

  for (const filePath of files) {
    const {
      segments,
    } = createManifestPath(filePath);

    if (segments.length < 2) {
      console.warn(
        `Skipping unsupported asset path: ${filePath}`,
      );

      continue;
    }

    const [group, collection] = segments;

    if (!manifest[group]) {
      console.warn(
        `Skipping unknown asset group "${group}".`,
      );

      continue;
    }

    if (!manifest[group][collection]) {
      manifest[group][collection] = [];
    }

    const uploadedImage = await uploadImage(
      filePath,
    );

    manifest[group][collection].push(
      uploadedImage,
    );
  }

  await fs.mkdir(OUTPUT_DIRECTORY, {
    recursive: true,
  });

  await fs.writeFile(
    OUTPUT_FILE,
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  console.log('');
  console.log('Seed assets uploaded.');
  console.log(`Manifest created: ${OUTPUT_FILE}`);
}

uploadSeedAssets().catch((error) => {
  console.error(
    'Seed asset upload failed:',
    error,
  );

  process.exitCode = 1;
});