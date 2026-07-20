// scripts/updateSeedUserPhotos.js
import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../src/models/User.js';

const MONGODB_URI = process.env.MONGO_URI;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

const PHOTOS_PER_USER = 3;
const RESULTS_PER_PAGE = 30;
const MAX_SEARCH_PAGES = 3;

const SEED_USERS = [
  {
    username: 'isabellexo',
    gender: 'female',
    queries: [
      'woman lifestyle portrait',
      'female portrait',
      'woman smiling portrait',
    ],
  },
  {
    username: 'sophiejade',
    gender: 'female',
    queries: [
      'woman travel portrait',
      'female outdoor portrait',
      'woman vacation portrait',
    ],
  },
  {
    username: 'lenaavaa',
    gender: 'female',
    queries: [
      'woman coffee portrait',
      'female cafe portrait',
      'woman lifestyle portrait',
    ],
  },
  {
    username: 'matthewjames',
    gender: 'male',
    queries: [
      'man outdoor portrait',
      'male hiking portrait',
      'man lifestyle portrait',
    ],
  },
  {
    username: 'alexmoreno',
    gender: 'male',
    queries: [
      'man urban portrait',
      'male city portrait',
      'man street portrait',
      'male lifestyle portrait',
    ],
  },
  {
    username: 'lukaswayfarer',
    gender: 'male',
    queries: [
      'man adventure portrait',
      'male outdoor portrait',
      'man hiking portrait',
    ],
  },
];

function validateEnvironment() {
  if (!MONGODB_URI) {
    throw new Error(
      'MONGO_URI is missing from the environment.',
    );
  }

  if (!UNSPLASH_ACCESS_KEY) {
    throw new Error(
      'UNSPLASH_ACCESS_KEY is missing from the environment.',
    );
  }
}

function unsplashHeaders() {
  return {
    Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`,
    'Accept-Version': 'v1',
  };
}

function highResolutionSquareUrl(rawUrl) {
  const url = new URL(rawUrl);

  url.searchParams.set('auto', 'format');
  url.searchParams.set('fit', 'crop');
  url.searchParams.set('crop', 'faces,center');
  url.searchParams.set('w', '1600');
  url.searchParams.set('h', '1600');
  url.searchParams.set('q', '90');

  return url.toString();
}

async function searchPhotos(query, page = 1) {
  const endpoint = new URL(
    'https://api.unsplash.com/search/photos',
  );

  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('page', String(page));
  endpoint.searchParams.set(
    'per_page',
    String(RESULTS_PER_PAGE),
  );
  endpoint.searchParams.set('orientation', 'squarish');
  endpoint.searchParams.set('content_filter', 'high');
  endpoint.searchParams.set('order_by', 'relevant');

  const response = await fetch(endpoint, {
    headers: unsplashHeaders(),
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Unsplash search failed for "${query}" ` +
        `(${response.status}): ${body}`,
    );
  }

  const data = await response.json();

  console.log(
    `Search "${query}" page ${page}/${data.total_pages ?? 0}: ` +
      `${data.results?.length ?? 0} results`,
  );

  return {
    results: data.results ?? [],
    totalPages: data.total_pages ?? 0,
  };
}

async function registerDownload(downloadLocation) {
  if (!downloadLocation) {
    return;
  }

  const response = await fetch(downloadLocation, {
    headers: unsplashHeaders(),
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Unsplash download registration failed ` +
        `(${response.status}): ${body}`,
    );
  }
}

function isUsablePhoto(photo) {
  if (!photo?.id || !photo.urls?.raw) {
    return false;
  }

  const width = Number(photo.width);
  const height = Number(photo.height);

  return width >= 1600 && height >= 1600;
}

async function choosePhotos({
  queries,
  usedPhotoIds,
}) {
  const selected = [];

  for (const query of queries) {
    const firstResponse = await searchPhotos(query, 1);

    const availablePages = Math.min(
      Math.max(firstResponse.totalPages, 1),
      MAX_SEARCH_PAGES,
    );

    for (
      let page = 1;
      page <= availablePages;
      page += 1
    ) {
      const response =
        page === 1
          ? firstResponse
          : await searchPhotos(query, page);

      for (const photo of response.results) {
        if (!isUsablePhoto(photo)) {
          continue;
        }

        if (usedPhotoIds.has(photo.id)) {
          continue;
        }

        selected.push(photo);
        usedPhotoIds.add(photo.id);

        if (selected.length === PHOTOS_PER_USER) {
          return selected;
        }
      }
    }
  }

  throw new Error(
    `Only found ${selected.length} usable photos. ` +
      `Queries attempted: ${queries.join(', ')}`,
  );
}

function toStoredPhoto(photo) {
  return {
    url: highResolutionSquareUrl(photo.urls.raw),
  };
}

async function loadAndValidateSeedUsers() {
  const usernames = SEED_USERS.map(
    ({ username }) => username,
  );

  const existingUsers = await User.find(
    {
      username: {
        $in: usernames,
      },
    },
    {
      username: 1,
      gender: 1,
    },
  ).lean();

  const usersByUsername = new Map(
    existingUsers.map((user) => [
      user.username,
      user,
    ]),
  );

  const missingUsers = usernames.filter(
    (username) => !usersByUsername.has(username),
  );

  if (missingUsers.length > 0) {
    throw new Error(
      `Seed users not found: ${missingUsers.join(', ')}`,
    );
  }

  for (const seedUser of SEED_USERS) {
    const existingUser = usersByUsername.get(
      seedUser.username,
    );

    if (existingUser.gender !== seedUser.gender) {
      throw new Error(
        `Gender mismatch for ${seedUser.username}. ` +
          `Expected "${seedUser.gender}", ` +
          `but database contains "${existingUser.gender}".`,
      );
    }
  }

  return existingUsers;
}

async function buildPhotoUpdates() {
  const usedPhotoIds = new Set();
  const operations = [];
  const updateSummary = [];

  for (const seedUser of SEED_USERS) {
    console.log('');
    console.log(
      `Finding photos for ${seedUser.username}...`,
    );

    const selectedPhotos = await choosePhotos({
      queries: seedUser.queries,
      usedPhotoIds,
    });

    for (const photo of selectedPhotos) {
      await registerDownload(
        photo.links?.download_location,
      );
    }

    const photos = selectedPhotos.map(
      toStoredPhoto,
    );

    operations.push({
      updateOne: {
        filter: {
          username: seedUser.username,
          gender: seedUser.gender,
          emailVerified: true,
        },
        update: {
          $set: {
            photos,
          },
        },
      },
    });

    updateSummary.push({
      username: seedUser.username,
      gender: seedUser.gender,
      photos: selectedPhotos.map((photo) => ({
        id: photo.id,
        url: highResolutionSquareUrl(
          photo.urls.raw,
        ),
        photographer:
          photo.user?.name ?? 'Unknown',
        attributionUrl:
          photo.links?.html ?? null,
      })),
    });
  }

  return {
    operations,
    updateSummary,
  };
}

function printSummary(updateSummary) {
  console.log('');
  console.log('Updated profile photos:');

  for (const profile of updateSummary) {
    console.log('');
    console.log(
      `${profile.username} (${profile.gender})`,
    );

    for (const photo of profile.photos) {
      console.log(`  URL: ${photo.url}`);
      console.log(
        `  Photographer: ${photo.photographer}`,
      );

      if (photo.attributionUrl) {
        console.log(
          `  Attribution: ${photo.attributionUrl}`,
        );
      }
    }
  }
}

async function updateSeedUserPhotos() {
  validateEnvironment();

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  await loadAndValidateSeedUsers();

  const {
    operations,
    updateSummary,
  } = await buildPhotoUpdates();

  const result = await User.bulkWrite(
    operations,
    {
      ordered: true,
    },
  );

  console.log('');
  console.log('Database update completed.');
  console.log(
    `Matched users: ${result.matchedCount}`,
  );
  console.log(
    `Modified users: ${result.modifiedCount}`,
  );

  printSummary(updateSummary);
}

updateSeedUserPhotos()
  .catch((error) => {
    console.error('');
    console.error(
      'Photo update failed:',
      error,
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });