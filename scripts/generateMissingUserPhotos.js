// scripts/generateMissingUserPhotos.js
import 'dotenv/config';
import mongoose from 'mongoose';
import OpenAI from 'openai';
import { v2 as cloudinary } from 'cloudinary';
import sharp from 'sharp';

import User from '../src/models/User.js';

const {
  MONGO_URI,
  OPENAI_API_KEY,
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
} = process.env;

const PHOTOS_PER_USER = 3;
const DEFAULT_LIMIT = 10;
const CLOUDINARY_FOLDER = 'localpulse/generated-profiles';

/*
 * This script intentionally processes demo/seed users only.
 *
 * To use this guard, add:
 *
 *   isSeedUser: {
 *     type: Boolean,
 *     default: false,
 *     index: true,
 *   }
 *
 * to your User schema and set isSeedUser: true on demo users.
 */

function validateEnvironment() {
  const missing = [];

  if (!MONGO_URI) missing.push('MONGO_URI');
  if (!OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!CLOUDINARY_CLOUD_NAME) {
    missing.push('CLOUDINARY_CLOUD_NAME');
  }
  if (!CLOUDINARY_API_KEY) {
    missing.push('CLOUDINARY_API_KEY');
  }
  if (!CLOUDINARY_API_SECRET) {
    missing.push('CLOUDINARY_API_SECRET');
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(', ')}`,
    );
  }
}

validateEnvironment();

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true,
});

function parseArguments() {
  const args = process.argv.slice(2);

  const dryRun = args.includes('--dry-run');

  const limitArgument = args.find((argument) =>
    argument.startsWith('--limit='),
  );

  const parsedLimit = limitArgument
    ? Number(limitArgument.split('=')[1])
    : DEFAULT_LIMIT;

  if (
    !Number.isInteger(parsedLimit) ||
    parsedLimit < 1 ||
    parsedLimit > 100
  ) {
    throw new Error(
      '--limit must be an integer between 1 and 100.',
    );
  }

  return {
    dryRun,
    limit: parsedLimit,
  };
}

function normalizeGender(gender) {
  const value = String(gender ?? '').trim().toLowerCase();

  if (value === 'female' || value === 'woman') {
    return 'woman';
  }

  if (value === 'male' || value === 'man') {
    return 'man';
  }

  return 'adult person';
}

function normalizeAge(age) {
  const numericAge = Number(age);

  if (
    Number.isInteger(numericAge) &&
    numericAge >= 18 &&
    numericAge <= 90
  ) {
    return numericAge;
  }

  return 30;
}

function safeText(value, maximumLength = 150) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximumLength);
}

function buildIdentityDescription(user) {
  const gender = normalizeGender(user.gender);
  const age = normalizeAge(user.age);
  const interests = Array.isArray(user.interests)
    ? user.interests
        .map((interest) => safeText(interest, 30))
        .filter(Boolean)
        .slice(0, 4)
    : [];

  const location = safeText(
    user.locationName || user.neighborhood,
    60,
  );

  return {
    gender,
    age,
    interests,
    location,
  };
}

function buildGenerationPrompt(user) {
  const identity = buildIdentityDescription(user);

  const interestDescription =
    identity.interests.length > 0
      ? identity.interests.join(', ')
      : 'everyday social activities';

  const locationDescription = identity.location
    ? `The visual atmosphere may subtly suit ${identity.location}, `
    : '';

  return `
Create a square 2-by-2 photographic contact sheet.

The contact sheet must show the exact same fictional adult person
in every occupied panel.

Person:
- approximately ${identity.age} years old
- ${identity.gender}
- natural, approachable appearance
- suitable for a friendly social-discovery app
- interests: ${interestDescription}

Use exactly three occupied panels:
1. A clear outdoor head-and-shoulders profile photograph.
2. A relaxed indoor café or home-lifestyle photograph.
3. A casual outdoor activity or city photograph.
4. The bottom-right panel must be a plain neutral background.

${locationDescription}
but do not include recognizable private addresses or landmarks.

Requirements:
- The same face, hair, apparent age, and identity in all three photos.
- Realistic professional photography.
- Natural skin texture.
- Appropriate everyday clothing.
- Friendly expressions.
- Square framing within every panel.
- No text.
- No logos.
- No watermarks.
- No borders or gaps between panels.
- No celebrities.
- No public figures.
- No real identifiable person.
- No nudity or sexualized presentation.
- All subjects must clearly be adults.
`.trim();
}

async function generateContactSheet(user) {
  const prompt = buildGenerationPrompt(user);

  const response = await openai.images.generate({
    model: 'gpt-image-1',
    prompt,
    size: '1024x1024',
    quality: 'high',
    n: 1,
  });

  const base64Image = response.data?.[0]?.b64_json;

  if (!base64Image) {
    throw new Error(
      `OpenAI did not return image data for ${user.username}.`,
    );
  }

  return Buffer.from(base64Image, 'base64');
}

async function splitContactSheet(contactSheetBuffer) {
  const metadata = await sharp(contactSheetBuffer).metadata();

  const width = metadata.width;
  const height = metadata.height;

  if (!width || !height) {
    throw new Error(
      'Could not determine generated image dimensions.',
    );
  }

  const panelWidth = Math.floor(width / 2);
  const panelHeight = Math.floor(height / 2);

  const panels = [
    {
      left: 0,
      top: 0,
      width: panelWidth,
      height: panelHeight,
    },
    {
      left: panelWidth,
      top: 0,
      width: width - panelWidth,
      height: panelHeight,
    },
    {
      left: 0,
      top: panelHeight,
      width: panelWidth,
      height: height - panelHeight,
    },
  ];

  return Promise.all(
    panels.slice(0, PHOTOS_PER_USER).map((panel) =>
      sharp(contactSheetBuffer)
        .extract(panel)
        .resize(1200, 1200, {
          fit: 'cover',
          position: 'attention',
        })
        .jpeg({
          quality: 92,
          mozjpeg: true,
        })
        .toBuffer(),
    ),
  );
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function uploadBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      },
    );

    stream.end(buffer);
  });
}

async function uploadUserPhotos(user, photoBuffers) {
  const username = slugify(
    user.username || user.displayName || String(user._id),
  );

  const uploaded = [];

  try {
    for (
      let index = 0;
      index < photoBuffers.length;
      index += 1
    ) {
      const result = await uploadBuffer(photoBuffers[index], {
        folder: `${CLOUDINARY_FOLDER}/${username}`,
        public_id: `profile-${index + 1}`,
        overwrite: true,
        invalidate: true,
        resource_type: 'image',
        format: 'jpg',
        tags: [
          'localpulse',
          'generated-profile',
          'seed-user',
        ],
        context: {
          generated: 'true',
          user_id: String(user._id),
          username: String(user.username ?? ''),
        },
      });

      if (!result?.secure_url || !result?.public_id) {
        throw new Error(
          `Cloudinary returned an incomplete result for ${username}.`,
        );
      }

      uploaded.push({
        url: result.secure_url,
        publicId: result.public_id,
      });
    }

    return uploaded;
  } catch (error) {
    /*
     * Roll back images already uploaded for this user when a later
     * upload fails.
     */
    await Promise.allSettled(
      uploaded.map((photo) =>
        cloudinary.uploader.destroy(photo.publicId, {
          resource_type: 'image',
          invalidate: true,
        }),
      ),
    );

    throw error;
  }
}

async function savePhotosIfStillEmpty(userId, photos) {
  /*
   * The query is repeated during the update to protect against a race:
   * a user could upload a real photo while this script is generating.
   */
  const result = await User.updateOne(
    {
      _id: userId,
      isSeedUser: true,
      $or: [
        { photos: { $exists: false } },
        { photos: null },
        { photos: { $size: 0 } },
      ],
    },
    {
      $set: {
        photos,
      },
    },
  );

  return result.modifiedCount === 1;
}

async function deleteUploadedPhotos(photos) {
  await Promise.allSettled(
    photos.map((photo) =>
      cloudinary.uploader.destroy(photo.publicId, {
        resource_type: 'image',
        invalidate: true,
      }),
    ),
  );
}

async function processUser(user, dryRun) {
  console.log('');
  console.log(
    `Processing ${user.username || user.displayName || user._id}...`,
  );

  if (dryRun) {
    console.log('  Dry run: no image generated or uploaded.');
    console.log(`  Gender prompt: ${normalizeGender(user.gender)}`);
    console.log(`  Age prompt: ${normalizeAge(user.age)}`);
    return {
      status: 'dry-run',
    };
  }

  const contactSheet = await generateContactSheet(user);
  console.log('  Generated contact sheet.');

  const photoBuffers = await splitContactSheet(contactSheet);
  console.log(`  Created ${photoBuffers.length} photo files.`);

  const uploadedPhotos = await uploadUserPhotos(
    user,
    photoBuffers,
  );

  console.log(
    `  Uploaded ${uploadedPhotos.length} photos to Cloudinary.`,
  );

  const saved = await savePhotosIfStillEmpty(
    user._id,
    uploadedPhotos,
  );

  if (!saved) {
    await deleteUploadedPhotos(uploadedPhotos);

    console.log(
      '  Skipped: profile received photos while processing.',
    );

    return {
      status: 'race-skipped',
    };
  }

  console.log('  MongoDB profile updated.');

  return {
    status: 'updated',
    photos: uploadedPhotos,
  };
}

async function findUsersWithoutPhotos(limit) {
  return User.find({
    isSeedUser: true,
    $or: [
      { photos: { $exists: false } },
      { photos: null },
      { photos: { $size: 0 } },
    ],
  })
    .select({
      username: 1,
      displayName: 1,
      age: 1,
      gender: 1,
      interests: 1,
      neighborhood: 1,
      locationName: 1,
      photos: 1,
      isSeedUser: 1,
    })
    .limit(limit)
    .lean();
}

async function run() {
  const { dryRun, limit } = parseArguments();

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB.');

  const users = await findUsersWithoutPhotos(limit);

  console.log(
    `Found ${users.length} seed user(s) without photos.`,
  );

  if (users.length === 0) {
    return;
  }

  const summary = {
    updated: 0,
    failed: 0,
    dryRun: 0,
    raceSkipped: 0,
  };

  /*
   * Process sequentially to control API usage and simplify rollback.
   */
  for (const user of users) {
    try {
      const result = await processUser(user, dryRun);

      if (result.status === 'updated') {
        summary.updated += 1;
      } else if (result.status === 'dry-run') {
        summary.dryRun += 1;
      } else if (result.status === 'race-skipped') {
        summary.raceSkipped += 1;
      }
    } catch (error) {
      summary.failed += 1;

      console.error(
        `  Failed for ${user.username || user._id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  console.log('');
  console.log('Completed.');
  console.log(`Updated: ${summary.updated}`);
  console.log(`Failed: ${summary.failed}`);
  console.log(`Dry run: ${summary.dryRun}`);
  console.log(`Race skipped: ${summary.raceSkipped}`);

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

run()
  .catch((error) => {
    console.error(
      'Generation script failed:',
      error instanceof Error ? error.message : error,
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });