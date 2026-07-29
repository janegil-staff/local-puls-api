// local-pulse-api/src/controllers/seedController.js

import { v2 as cloudinary } from "cloudinary";
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User, { snapCoords, defaultShowFor } from "../models/User.js";
import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import { INTERESTS, MAX_INTERESTS } from "../lib/interests.js";
import {
  startJob,
  getJob,
  listJobs,
  requestCancel,
  serialiseJob,
  JobConflictError,
} from "../lib/seedJobs.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Paths and constants
// ---------------------------------------------------------------------------

// From src/controllers/ this resolves to the repository root. If the file is
// ever moved, set SEED_PROJECT_ROOT rather than editing the traversal.
const PROJECT_ROOT =
  process.env.SEED_PROJECT_ROOT || path.resolve(__dirname, "../../");

const ASSET_ROOT = path.join(PROJECT_ROOT, "seed-assets");
const MANIFEST_DIR = path.join(PROJECT_ROOT, "generated");
const MANIFEST_PATH = path.join(MANIFEST_DIR, "seedAssetManifest.json");

// The prefix scan is confined to this. Nothing outside it is touched by
// category 1 of the asset sweep.
const ASSET_PREFIX = "localpulse/seed-assets";

const FOLDERS_DEEPEST_FIRST = [
  "localpulse/seed-assets/avatars",
  "localpulse/seed-assets/posts",
  "localpulse/seed-assets",
];

const SUPPORTED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const DEMO_EMAIL_DOMAIN = "@example.test";
const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD || "2255";

const DEFAULT_CENTER_LAT = 60.3913;
const DEFAULT_CENTER_LNG = 5.3221;
const DEFAULT_NUMBER_OF_POSTS = 30;

// ---------------------------------------------------------------------------
// Errors, guards, logging
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

// These endpoints delete media and user documents. Being unlisted is not a
// guard — require an authenticated admin, and refuse in production unless
// somebody has deliberately opted in via env.
function assertSeedingAllowed(req) {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_SEEDING !== "true"
  ) {
    throw new HttpError(403, "Seeding endpoints are disabled in production.");
  }
  if (req?.user?.role !== "admin") {
    throw new HttpError(403, "Admin role required.");
  }
}

function assertConfirmed(req) {
  const confirm = req?.body?.confirm;
  if (confirm !== true && confirm !== "--confirm") {
    throw new HttpError(
      400,
      'Destructive operation requires { "confirm": true }.',
    );
  }
}

// The app owns the mongoose connection. These functions must never connect or
// disconnect — a disconnect here takes down every other request in flight.
function assertDatabaseReady() {
  if (mongoose.connection.readyState !== 1) {
    throw new HttpError(503, "MongoDB is not connected.");
  }
}

// Collects the lines the old scripts printed, so the HTTP caller gets the same
// narrative the terminal used to give.
function createLogger() {
  const lines = [];
  const log = (message = "") => {
    const text = String(message);
    lines.push(text);
    console.log(text);
  };
  log.lines = lines;
  return log;
}

async function respond(req, res, task) {
  try {
    const log = createLogger();
    const result = await task(log);
    return res.status(200).json({ ok: true, ...result, log: log.lines });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error("Seed operation failed:", error);
    return res.status(status).json({
      ok: false,
      error: error?.message || "Seed operation failed.",
    });
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Escape every regex metacharacter, not just the first one. String.replace with
// a string pattern only replaces the FIRST occurrence, so `.replace('.', '\\.')`
// silently leaves later dots unescaped.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i += 1) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

function configureCloudinary() {
  const required = [
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new HttpError(
      500,
      `Missing environment variables: ${missing.join(", ")}`,
    );
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

// Schema field names differ between projects. Resolve them at runtime so this
// code does not silently match nothing because the field is called `members`
// rather than `participants`.
function resolveField(model, candidates) {
  const found = candidates.find((name) => model.schema.path(name));
  if (!found) {
    throw new HttpError(
      500,
      `${model.modelName}: none of these fields exist — ${candidates.join(", ")}. ` +
        "Check the schema and update the candidate list.",
    );
  }
  return found;
}

// Same, but returns null instead of throwing — for genuinely optional fields
// such as comment threading, which not every schema has.
function optionalField(model, candidates) {
  return candidates.find((name) => model.schema.path(name)) ?? null;
}

// Mongoose stores minlength/maxlength either as a number or as [n, "message"].
function schemaLengthBound(model, field, key, fallback) {
  const option = model.schema.path(field)?.options?.[key];
  if (typeof option === "number") return option;
  if (Array.isArray(option) && typeof option[0] === "number") return option[0];
  return fallback;
}

// ---------------------------------------------------------------------------
// Cloudinary reference extraction
// ---------------------------------------------------------------------------

// Many records store only a delivery URL, not a public ID. Recover the ID from
// the URL: everything after /upload/, minus any transformation segment and the
// version, minus the file extension.
//
//   https://res.cloudinary.com/demo/image/upload/c_fill,w_300/v1712/a/b.webp
//     -> a/b
function publicIdFromUrl(url) {
  if (typeof url !== "string" || !url.includes("res.cloudinary.com"))
    return null;

  const afterUpload = url.split("/upload/")[1];
  if (!afterUpload) return null;

  const segments = afterUpload.split("/");

  // Drop a leading transformation segment (contains a comma or starts with a
  // known transformation prefix) and the version segment (v1234567890).
  while (segments.length > 1) {
    const segment = segments[0];
    const isTransformation =
      segment.includes(",") || /^[a-z]{1,3}_/.test(segment);
    const isVersion = /^v\d+$/.test(segment);
    if (!isTransformation && !isVersion) break;
    segments.shift();
  }

  const withExtension = segments.join("/");
  const lastDot = withExtension.lastIndexOf(".");
  const publicId =
    lastDot > 0 ? withExtension.slice(0, lastDot) : withExtension;

  return publicId.split("?")[0] || null;
}

const ID_KEYS = ["publicId", "public_id", "cloudinaryId", "cloudinary_id"];
const URL_KEYS = ["url", "secureUrl", "secure_url", "imageUrl", "src", "path"];

// Walks any value — string, object, array, nested — and collects anything that
// looks like a Cloudinary reference. Schemas differ between projects and change
// over time; this avoids silently finding nothing because a field is called
// `imageUrl` rather than `image.url`.
function collectFromValue(value, into, depth = 0) {
  if (value == null || depth > 6) return;

  if (typeof value === "string") {
    const fromUrl = publicIdFromUrl(value);
    if (fromUrl) into.add(fromUrl);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectFromValue(entry, into, depth + 1);
    return;
  }

  if (typeof value !== "object") return;
  if (value instanceof Date || value instanceof mongoose.Types.ObjectId) return;

  for (const [key, nested] of Object.entries(value)) {
    if (ID_KEYS.includes(key) && typeof nested === "string" && nested.trim()) {
      into.add(nested.trim());
      continue;
    }
    if (URL_KEYS.includes(key) && typeof nested === "string") {
      const fromUrl = publicIdFromUrl(nested);
      if (fromUrl) into.add(fromUrl);
      continue;
    }
    collectFromValue(nested, into, depth + 1);
  }
}

function demoUserQuery() {
  // Match demo users by email domain OR the isSeedUser flag, so this works
  // whether or not isSeedUser persisted. The regex is anchored to the end of
  // the string so it cannot match a real user who merely contains the text.
  return {
    $or: [
      {
        email: { $regex: `${escapeRegex(DEMO_EMAIL_DOMAIN)}$`, $options: "i" },
      },
      { isSeedUser: true },
    ],
  };
}

// ---------------------------------------------------------------------------
// Seed data definitions
// ---------------------------------------------------------------------------

const POST_TYPES = [
  "update",
  "event",
  "recommendation",
  "lostfound",
  "marketplace",
  "question",
];

const PLACE_NAMES = [
  "Sentrum",
  "Nordnes",
  "Møhlenpris",
  "Sandviken",
  "Årstad",
  "Laksevåg",
  "Landås",
  "Solheim",
];

const femalePhoto = (n) => ({
  url: `https://randomuser.me/api/portraits/women/${n}.jpg`,
});
const malePhoto = (n) => ({
  url: `https://randomuser.me/api/portraits/men/${n}.jpg`,
});

// 10 female + 10 male. `fallbackPhoto` is used only if the manifest has no
// avatar for that username. `imageCategory` on each post below must be a folder
// that exists in the manifest.
//
// Interests are CURATED to match each bio, not randomised. Two reasons:
//
//   1. Random interests contradict the bio. "Coffee, city walks, photography"
//      paired with gaming/baking/climbing reads as noise, and the demo is the
//      thing you show people.
//   2. Random draws from 24 options almost never overlap, so the shared-
//      interest highlighting on the public profile never fires — the feature
//      looks broken in exactly the screen you would demo it in.
//
// The overlap here is deliberate: coffee, food, music, travel and photography
// each appear on several profiles, so any two users are likely to share one.
const DEMO_PROFILES = [
  {
    username: "isabellexo",
    email: "isabelle@example.test",
    displayName: "Isabelle",
    age: 25,
    gender: "female",
    bio: "Coffee, city walks, photography and meeting new people.",
    neighborhood: "Sentrum",
    interests: ["coffee", "photography", "travel"],
    fallbackPhoto: femalePhoto(44),
  },
  {
    username: "sophiejade",
    email: "sophie@example.test",
    displayName: "Sophie",
    age: 27,
    gender: "female",
    bio: "Designer, brunch enthusiast and weekend explorer.",
    neighborhood: "Nordnes",
    interests: ["design", "food", "travel"],
    fallbackPhoto: femalePhoto(47),
  },
  {
    username: "lenaavaa",
    email: "lena@example.test",
    displayName: "Lena",
    age: 24,
    gender: "female",
    bio: "Music, books, yoga and quiet cafés.",
    neighborhood: "Møhlenpris",
    interests: ["music", "books", "yoga", "coffee"],
    fallbackPhoto: femalePhoto(49),
  },
  {
    username: "emiliaro",
    email: "emilia@example.test",
    displayName: "Emilia",
    age: 29,
    gender: "female",
    bio: "Creative soul who enjoys art, food and local events.",
    neighborhood: "Sandviken",
    interests: ["art", "food", "concerts"],
    fallbackPhoto: femalePhoto(52),
  },
  {
    username: "noraexplores",
    email: "nora@example.test",
    displayName: "Nora",
    age: 26,
    gender: "female",
    bio: "Always looking for a new trail, view or hidden gem.",
    neighborhood: "Årstad",
    interests: ["hiking", "nature", "photography"],
    fallbackPhoto: femalePhoto(55),
  },
  {
    username: "amaliemusic",
    email: "amalie@example.test",
    displayName: "Amalie",
    age: 28,
    gender: "female",
    bio: "Musician, concert lover and occasional songwriter.",
    neighborhood: "Landås",
    interests: ["music", "concerts", "art"],
    fallbackPhoto: femalePhoto(58),
  },
  {
    username: "miafit",
    email: "mia@example.test",
    displayName: "Mia",
    age: 25,
    gender: "female",
    bio: "Running, strength training and healthy food.",
    neighborhood: "Solheim",
    interests: ["running", "fitness", "food"],
    fallbackPhoto: femalePhoto(61),
  },
  {
    username: "claraart",
    email: "clara@example.test",
    displayName: "Clara",
    age: 30,
    gender: "female",
    bio: "Illustrator interested in exhibitions and local culture.",
    neighborhood: "Laksevåg",
    interests: ["art", "design", "books"],
    fallbackPhoto: femalePhoto(63),
  },
  {
    username: "ellabakes",
    email: "ella@example.test",
    displayName: "Ella",
    age: 26,
    gender: "female",
    bio: "Baking, sharing recipes and discovering local bakeries.",
    neighborhood: "Sentrum",
    interests: ["baking", "cooking", "coffee"],
    fallbackPhoto: femalePhoto(65),
  },
  {
    username: "sarahlives",
    email: "sarah@example.test",
    displayName: "Sarah",
    age: 28,
    gender: "female",
    bio: "Enjoying city life one neighborhood at a time.",
    neighborhood: "Nordnes",
    interests: ["travel", "food", "photography"],
    fallbackPhoto: femalePhoto(68),
  },
  {
    username: "matthewjames",
    email: "matthew@example.test",
    displayName: "Matthew",
    age: 29,
    gender: "male",
    bio: "Coffee, football, travel and spontaneous plans.",
    neighborhood: "Sentrum",
    interests: ["coffee", "football", "travel"],
    fallbackPhoto: malePhoto(32),
  },
  {
    username: "alexmoreno",
    email: "alex@example.test",
    displayName: "Alex",
    age: 27,
    gender: "male",
    bio: "Designer who enjoys food, music and city photography.",
    neighborhood: "Møhlenpris",
    interests: ["design", "food", "music", "photography"],
    fallbackPhoto: malePhoto(35),
  },
  {
    username: "lukaswayfarer",
    email: "lukas@example.test",
    displayName: "Lukas",
    age: 31,
    gender: "male",
    bio: "Hiking, travelling and searching for the best views.",
    neighborhood: "Sandviken",
    interests: ["hiking", "travel", "nature"],
    fallbackPhoto: malePhoto(37),
  },
  {
    username: "olivercodes",
    email: "oliver@example.test",
    displayName: "Oliver",
    age: 28,
    gender: "male",
    bio: "Developer, gamer and regular at local coffee shops.",
    neighborhood: "Årstad",
    interests: ["technology", "gaming", "coffee"],
    fallbackPhoto: malePhoto(39),
  },
  {
    username: "noahfitness",
    email: "noah@example.test",
    displayName: "Noah",
    age: 25,
    gender: "male",
    bio: "Training, running and helping people stay active.",
    neighborhood: "Landås",
    interests: ["fitness", "running", "cooking"],
    fallbackPhoto: malePhoto(41),
  },
  {
    username: "henrikoutside",
    email: "henrik@example.test",
    displayName: "Henrik",
    age: 32,
    gender: "male",
    bio: "Outdoors whenever possible. Hiking, skiing and cycling.",
    neighborhood: "Solheim",
    interests: ["hiking", "cycling", "nature", "climbing"],
    fallbackPhoto: malePhoto(43),
  },
  {
    username: "danielcreates",
    email: "daniel@example.test",
    displayName: "Daniel",
    age: 27,
    gender: "male",
    bio: "Filmmaker interested in stories, art and collaboration.",
    neighborhood: "Laksevåg",
    interests: ["movies", "art", "photography"],
    fallbackPhoto: malePhoto(45),
  },
  {
    username: "williamfoodie",
    email: "william@example.test",
    displayName: "William",
    age: 30,
    gender: "male",
    bio: "Trying restaurants and sharing local food recommendations.",
    neighborhood: "Sentrum",
    interests: ["food", "cooking", "coffee"],
    fallbackPhoto: malePhoto(48),
  },
  {
    username: "theomusic",
    email: "theo@example.test",
    displayName: "Theo",
    age: 26,
    gender: "male",
    bio: "Guitar, live music and relaxed evenings with friends.",
    neighborhood: "Nordnes",
    interests: ["music", "concerts", "movies"],
    fallbackPhoto: malePhoto(51),
  },
  {
    username: "jacobmoves",
    email: "jacob@example.test",
    displayName: "Jacob",
    age: 29,
    gender: "male",
    bio: "Dancing, movement and discovering new local activities.",
    neighborhood: "Møhlenpris",
    interests: ["dancing", "fitness", "music"],
    fallbackPhoto: malePhoto(53),
  },
];

// Each post: type, text, and an imageCategory that matches a manifest folder.
// ~80% get images; the remainder set imageCategory: null (text-only).
const DEMO_POSTS = [
  {
    username: "isabellexo",
    type: "recommendation",
    text: "This café has become one of my favorite places to work.",
    imageCategory: "coffee",
  },
  {
    username: "theomusic",
    type: "update",
    text: "Working on a new song this evening.",
    imageCategory: "music",
  },
  {
    username: "noraexplores",
    type: "recommendation",
    text: "Found a beautiful walking route nearby today.",
    imageCategory: "outdoors",
  },
  {
    username: "miafit",
    type: "event",
    text: "Beginner-friendly morning run tomorrow. All welcome.",
    imageCategory: "fitness",
  },
  {
    username: "williamfoodie",
    type: "recommendation",
    text: "Highly recommend this place for a relaxed lunch.",
    imageCategory: "food",
  },
  {
    username: "ellabakes",
    type: "update",
    text: "Fresh cinnamon rolls just came out of the oven.",
    imageCategory: "food",
  },
  {
    username: "olivercodes",
    type: "question",
    text: "Favorite quiet café for working remotely?",
    imageCategory: "coffee",
  },
  {
    username: "amaliemusic",
    type: "event",
    text: "Small acoustic concert this Friday evening.",
    imageCategory: "events",
  },
  {
    username: "lukaswayfarer",
    type: "update",
    text: "The evening view over the city was worth the climb.",
    imageCategory: "outdoors",
  },
  {
    username: "claraart",
    type: "recommendation",
    text: "A small local exhibition worth visiting this weekend.",
    imageCategory: "events",
  },
  {
    username: "jacobmoves",
    type: "event",
    text: "Free outdoor dance session on Sunday afternoon.",
    imageCategory: "events",
  },
  {
    username: "noahfitness",
    type: "question",
    text: "Any beginner-friendly running groups nearby?",
    imageCategory: "fitness",
  },
  {
    username: "matthewjames",
    type: "update",
    text: "Slow Saturday morning with coffee and no plans.",
    imageCategory: "coffee",
  },
  {
    username: "danielcreates",
    type: "update",
    text: "Scouting locations for a small film project.",
    imageCategory: "city",
  },
  {
    username: "sophiejade",
    type: "recommendation",
    text: "The weekend market has so many good local products.",
    imageCategory: "city",
  },
  {
    username: "sarahlives",
    type: "update",
    text: "A quiet walk by the water before sunset.",
    imageCategory: "city",
  },
  {
    username: "henrikoutside",
    type: "event",
    text: "Planning an easy weekend hike. Message me to join.",
    imageCategory: "outdoors",
  },
  {
    username: "alexmoreno",
    type: "recommendation",
    text: "Great little restaurant with a relaxed atmosphere.",
    imageCategory: "food",
  },
  {
    username: "emiliaro",
    type: "event",
    text: "There is a neighborhood art market here on Sunday.",
    imageCategory: "events",
  },
  {
    username: "lenaavaa",
    type: "update",
    text: "Found a peaceful corner for reading this afternoon.",
    imageCategory: "outdoors",
  },
  {
    username: "isabellexo",
    type: "question",
    text: "Where is the best place for brunch around here?",
    imageCategory: "food",
  },
  {
    username: "theomusic",
    type: "event",
    text: "Local musicians meeting for an informal jam session.",
    imageCategory: "music",
  },
  {
    username: "olivercodes",
    type: "marketplace",
    text: "Selling a comfortable desk chair in good condition.",
    imageCategory: "marketplace",
  },
  {
    username: "matthewjames",
    type: "lostfound",
    text: "Found a set of keys near the park. Message me.",
    imageCategory: "lostfound",
  },
  // ── text-only (imageCategory: null) — ~20% ──
  {
    username: "claraart",
    type: "question",
    text: "Does anyone know a good local framing shop?",
    imageCategory: null,
  },
  {
    username: "jacobmoves",
    type: "question",
    text: "Any beginner-friendly dance classes nearby?",
    imageCategory: null,
  },
  {
    username: "sophiejade",
    type: "update",
    text: "Hope everyone is having a relaxed Sunday.",
    imageCategory: null,
  },
  {
    username: "noraexplores",
    type: "question",
    text: "Favorite walking route in this area?",
    imageCategory: null,
  },
  {
    username: "miafit",
    type: "update",
    text: "Perfect weather for an afternoon run.",
    imageCategory: null,
  },
  {
    username: "williamfoodie",
    type: "update",
    text: "A slow evening and a good book.",
    imageCategory: null,
  },
];

// Mixed-locale comment pool. Kept generic/positive so they fit any post.
// no, en, nl, fr, de, it, sv, da, fi, es, pl, pt
const SEED_COMMENT_TEXTS = [
  "Så bra! 🙌", // no
  "Elsker dette!", // no
  "Love this!", // en
  "This is great 👏", // en
  "Wat leuk!", // nl
  "Mooi zo!", // nl
  "Trop bien !", // fr
  "J’adore 😍", // fr
  "Wie schön!", // de
  "Toll gemacht!", // de
  "Che bello!", // it
  "Bellissimo 😍", // it
  "Vad fint!", // sv
  "Snyggt! 🙌", // sv
  "Hvor fedt!", // da
  "Super lækkert", // da
  "Mahtavaa!", // fi
  "Tosi hyvä 👏", // fi
  "¡Qué bueno! 🙌", // es
  "Me encanta 😍", // es
  "Świetne!", // pl
  "Uwielbiam to ❤️", // pl
  "Que fixe!", // pt
  "Adoro isto 😍", // pt
];

// ---------------------------------------------------------------------------
// Asset upload
// ---------------------------------------------------------------------------

function normalizePathSegment(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-");
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
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      const nestedFiles = await collectImageFiles(fullPath);
      files.push(...nestedFiles);
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (SUPPORTED_EXTENSIONS.has(extension)) {
      files.push(fullPath);
    }
  }

  return files;
}

function createManifestPath(filePath) {
  const relativePath = path.relative(ASSET_ROOT, filePath);
  const parsed = path.parse(relativePath);

  return {
    relativePath,
    segments: parsed.dir.split(path.sep).filter(Boolean),
    filename: parsed.name,
  };
}

async function uploadImage(filePath, log) {
  const { relativePath, segments, filename } = createManifestPath(filePath);

  const cloudinaryFolder = [
    "localpulse",
    "seed-assets",
    ...segments.map(normalizePathSegment),
  ].join("/");

  const publicId = normalizePathSegment(filename);

  log(`Uploading ${relativePath}`);

  const result = await cloudinary.uploader.upload(filePath, {
    folder: cloudinaryFolder,
    public_id: publicId,
    overwrite: true,
    resource_type: "image",
    transformation: [{ quality: "auto", fetch_format: "auto" }],
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    width: result.width,
    height: result.height,
  };
}

export async function runUploadSeedAssets(log = createLogger()) {
  configureCloudinary();

  if (!(await directoryExists(ASSET_ROOT))) {
    throw new HttpError(
      500,
      `Seed asset directory does not exist: ${ASSET_ROOT}`,
    );
  }

  const files = await collectImageFiles(ASSET_ROOT);
  if (files.length === 0) {
    throw new HttpError(500, `No image files found inside ${ASSET_ROOT}`);
  }

  log(`Found ${files.length} seed images.`);

  const manifest = { avatars: {}, posts: {} };
  let uploaded = 0;
  let skipped = 0;

  for (const filePath of files) {
    const { segments } = createManifestPath(filePath);

    if (segments.length < 2) {
      log(`Skipping unsupported asset path: ${filePath}`);
      skipped += 1;
      continue;
    }

    const [group, collection] = segments;

    if (!manifest[group]) {
      log(`Skipping unknown asset group "${group}".`);
      skipped += 1;
      continue;
    }

    if (!manifest[group][collection]) {
      manifest[group][collection] = [];
    }

    const uploadedImage = await uploadImage(filePath, log);
    manifest[group][collection].push(uploadedImage);
    uploaded += 1;
  }

  await fs.mkdir(MANIFEST_DIR, { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");

  log("");
  log("Seed assets uploaded.");
  log(`Manifest created: ${MANIFEST_PATH}`);

  return {
    step: "uploadSeedAssets",
    filesFound: files.length,
    uploaded,
    skipped,
    manifestPath: MANIFEST_PATH,
  };
}

export async function uploadSeedAssets(req, res) {
  return respond(req, res, async (log) => {
    assertSeedingAllowed(req);
    return runUploadSeedAssets(log);
  });
}

// ---------------------------------------------------------------------------
// Demo data seed
// ---------------------------------------------------------------------------

// dob from age (model stores dob; age is a derived virtual). UTC, exact age.
function dobForAge(age) {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear() - age, now.getUTCMonth(), now.getUTCDate()),
  );
}

function jitter(lat, lng, km = 5) {
  const dLat = (Math.random() - 0.5) * 2 * (km / 111);
  const dLng =
    (Math.random() - 0.5) * 2 * (km / (111 * Math.cos((lat * Math.PI) / 180)));
  return [lng + dLng, lat + dLat];
}

function randomDateWithinLastDays(days) {
  return new Date(
    Date.now() - Math.floor(Math.random() * days * 24 * 60 * 60 * 1000),
  );
}

function randomLikes(users, authorId) {
  const others = users.filter((u) => String(u._id) !== String(authorId));
  const n = Math.floor(Math.random() * 11);
  const copy = [...others];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n).map((u) => u._id);
}

// Interests are stored in canonical list order, matching sanitiseInterests on
// the API, so a seeded user and a real user hold the same shape. That matters
// for any "shared interests" comparison — a straight set intersection only
// works if both sides are normalised the same way.
function normaliseInterests(list, username) {
  const unique = [...new Set((list || []).map((v) => String(v).toLowerCase()))];

  const unknown = unique.filter((id) => !INTERESTS.includes(id));
  if (unknown.length) {
    // Fail loudly at seed time rather than writing a value the API will later
    // refuse. With an enum on the model this would block every subsequent save
    // on that document, not just this field.
    throw new HttpError(
      500,
      `"${username}" has unknown interest(s): ${unknown.join(", ")}. ` +
        "Valid values are in src/lib/interests.js",
    );
  }

  if (unique.length > MAX_INTERESTS) {
    throw new HttpError(
      500,
      `"${username}" has ${unique.length} interests; the maximum is ${MAX_INTERESTS}.`,
    );
  }

  return INTERESTS.filter((id) => unique.includes(id));
}

// Normalize a manifest entry ({url,publicId,...} or bare string) to {url,publicId?}.
function normImg(x) {
  if (typeof x === "string") return { url: x };
  if (x && typeof x === "object" && typeof x.url === "string") {
    return { url: x.url, ...(x.publicId ? { publicId: x.publicId } : {}) };
  }
  return null;
}

async function loadManifest() {
  const raw = await fs.readFile(MANIFEST_PATH, "utf8").catch(() => {
    throw new HttpError(
      409,
      `Manifest not found at ${MANIFEST_PATH}. Run the uploadSeedAssets step first.`,
    );
  });

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new HttpError(500, `Manifest at ${MANIFEST_PATH} is not valid JSON.`);
  }

  if (!manifest?.posts || !manifest?.avatars) {
    throw new HttpError(500, 'Manifest must contain "avatars" and "posts".');
  }
  return manifest;
}

async function seedUsers(passwordHash, manifest, center, log) {
  const users = [];

  for (const p of DEMO_PROFILES) {
    const existing = await User.findOne({
      $or: [{ username: p.username }, { email: p.email }],
    });

    if (existing && existing.isSeedUser !== true) {
      throw new HttpError(
        409,
        `"${p.username}" collides with a non-demo user (${existing.email}).`,
      );
    }

    const filter = existing ? { _id: existing._id } : { username: p.username };
    const [lng, lat] = jitter(center.lat, center.lng, 5);

    // Prefer manifest avatar(s); fall back to RandomUser if none.
    const manifestAvatars = (manifest.avatars?.[p.username] || [])
      .map(normImg)
      .filter(Boolean);
    const photos = manifestAvatars.length ? manifestAvatars : [p.fallbackPhoto];

    const doc = {
      username: p.username,
      email: p.email,
      displayName: p.displayName,
      passwordHash,
      dob: dobForAge(p.age),
      gender: p.gender,
      bio: p.bio,
      neighborhood: p.neighborhood,
      interests: normaliseInterests(p.interests, p.username),

      // Discovery defaults derived from gender: male -> female, female -> male,
      // anything else -> everyone. Uses the model's own defaultShowFor so seeded
      // users match what registration produces, rather than a second copy of the
      // rule that can drift.
      //
      // showSetByUser stays false: this is a default, not a choice the user
      // made. Anything that later re-derives the default must be able to tell
      // those apart, or it will overwrite real preferences.
      preferences: {
        show: defaultShowFor(p.gender),
        showSetByUser: false,
        ageMin: 18,
        ageMax: 99,
        // null = Anywhere. Seed users are scattered ~5km apart, so a radius
        // would work — but a new tester in another city would see an empty
        // Discover screen and conclude the app is broken.
        maxDistanceKm: null,
      },

      photos,
      profileComplete: true,
      location: { type: "Point", coordinates: snapCoords([lng, lat]) },
      locationName: p.neighborhood,
      locationMode: "manual",
      emailVerified: true,
      isSeedUser: true,
    };

    const user = await User.findOneAndUpdate(
      filter,
      { $set: doc },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    users.push(user);
    log(
      `Seeded user: ${user.username}${manifestAvatars.length ? "" : " (fallback avatar)"}`,
    );
  }

  log(`Finished seeding ${users.length} users.`);
  return users;
}

// Cycle images within a category so repeats are spread out.
function makeImagePicker(manifest) {
  const counters = new Map();
  return (category) => {
    if (!category) return "";
    const imgs = (manifest.posts?.[category] || [])
      .map(normImg)
      .filter(Boolean);
    if (imgs.length === 0) return ""; // category missing -> degrade to text-only
    const i = counters.get(category) ?? 0;
    counters.set(category, i + 1);
    return imgs[i % imgs.length].url;
  };
}

async function seedPosts(users, manifest, options, log) {
  const userIds = users.map((u) => u._id);
  const del = await Post.deleteMany({ author: { $in: userIds } });
  log(`Removed ${del.deletedCount} old posts by these users.`);

  const usersByName = new Map(users.map((u) => [u.username, u]));
  const imageFor = makeImagePicker(manifest);

  // Use the fixed DEMO_POSTS (matched text+category). If numberOfPosts differs
  // from the list length, cycle through the list.
  const docs = [];
  for (let i = 0; i < options.numberOfPosts; i += 1) {
    const def = DEMO_POSTS[i % DEMO_POSTS.length];
    const author = usersByName.get(def.username) || pick(users);
    const [lng, lat] = jitter(options.center.lat, options.center.lng, 5);
    const createdAt = randomDateWithinLastDays(30);

    docs.push({
      author: author._id,
      type: POST_TYPES.includes(def.type) ? def.type : "update",
      text: def.text,
      imageUrl: imageFor(def.imageCategory), // '' when null/missing category
      location: { type: "Point", coordinates: [lng, lat] },
      placeName: pick(PLACE_NAMES),
      likes: randomLikes(users, author._id),
      createdAt,
      updatedAt: createdAt,
    });
  }

  let inserted = [];
  const writeErrors = [];

  try {
    inserted = await Post.insertMany(docs, { ordered: false });
  } catch (err) {
    log("insertMany reported errors:");
    if (err.writeErrors) {
      for (const we of err.writeErrors) {
        const message = `  index ${we.index}: ${we.errmsg || we.err?.errmsg}`;
        writeErrors.push(message);
        log(message);
      }
    } else {
      writeErrors.push(err.message);
      log(err.message);
    }
    inserted = err.insertedDocs || [];
  }

  const withImages = inserted.filter((p) => p.imageUrl).length;
  log(`Created ${inserted.length} posts.`);
  log(
    `With images: ${withImages} | text-only: ${inserted.length - withImages}`,
  );

  return { posts: inserted, withImages, writeErrors };
}

// How often each interest appears across the seed set. Reported at the end so a
// thin spread is visible before you demo the app rather than during it.
function interestSpread() {
  const counts = new Map();
  for (const p of DEMO_PROFILES) {
    for (const id of p.interests || []) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export async function runSeedDemoData(options = {}, log = createLogger()) {
  assertDatabaseReady();

  const center = {
    lat: Number.isFinite(Number(options.lat))
      ? Number(options.lat)
      : DEFAULT_CENTER_LAT,
    lng: Number.isFinite(Number(options.lng))
      ? Number(options.lng)
      : DEFAULT_CENTER_LNG,
  };
  const numberOfPosts = Number.isFinite(Number(options.posts))
    ? Math.max(0, Math.floor(Number(options.posts)))
    : DEFAULT_NUMBER_OF_POSTS;

  const manifest = await loadManifest();

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const users = await seedUsers(passwordHash, manifest, center, log);
  const { posts, withImages, writeErrors } = await seedPosts(
    users,
    manifest,
    { center, numberOfPosts },
    log,
  );

  const shows = DEMO_PROFILES.reduce((acc, p) => {
    const key = `${p.gender} → ${defaultShowFor(p.gender)}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  log("");
  log("Discovery defaults:");
  for (const [k, n] of Object.entries(shows)) log(`  ${k.padEnd(22)} ${n}`);

  log("");
  log("Demo data seed completed.");
  log(`Users: ${users.length}`);
  log(`Posts: ${posts.length}`);
  log(`Scatter center: [lng ${center.lng}, lat ${center.lat}] (~5km).`);
  log("");
  log("Interest spread (shared interests need overlap to be visible):");

  const spread = interestSpread();
  for (const [id, n] of spread) {
    log(`  ${id.padEnd(14)} ${"█".repeat(n)} ${n}`);
  }

  return {
    step: "seedDemoData",
    users: users.length,
    posts: posts.length,
    postsWithImages: withImages,
    center,
    writeErrors,
    interestSpread: Object.fromEntries(spread),
  };
}

export async function seedDemoData(req, res) {
  return respond(req, res, async (log) => {
    assertSeedingAllowed(req);
    // Options come off the request body — there are no CLI args in a server.
    const { lat, lng, posts } = req.body ?? {};
    return runSeedDemoData({ lat, lng, posts }, log);
  });
}

// ---------------------------------------------------------------------------
// Comment seed / unseed
// ---------------------------------------------------------------------------
//
// These use the raw driver collection rather than the Comment model on purpose:
// `isSeed` is not necessarily a declared schema path, and with strictQuery on,
// mongoose would strip it from the filter — turning a targeted delete into a
// delete-everything. The raw collection sends the filter through untouched.

export async function runSeedComments(log = createLogger()) {
  assertDatabaseReady();

  const minLength = schemaLengthBound(Comment, "text", "minlength", 1);
  const maxLength = schemaLengthBound(Comment, "text", "maxlength", 500);

  const db = mongoose.connection.db;
  const usersCollection = db.collection(User.collection.name);
  const postsCollection = db.collection(Post.collection.name);
  const commentsCollection = db.collection(Comment.collection.name);

  // Seed users = the pool of commenters.
  const seedUsers = await usersCollection
    .find({ isSeedUser: true })
    .project({ _id: 1 })
    .toArray();

  if (seedUsers.length === 0) {
    throw new HttpError(
      409,
      "No seed users (isSeedUser: true) found. Seed users first.",
    );
  }

  const seedUserIds = seedUsers.map((u) => u._id);
  log(`Found ${seedUserIds.length} seed users.`);

  // A seeded post is one authored by a seed user. If Post ever grows its own
  // isSeed flag, widen this to an $or.
  const seededPosts = await postsCollection
    .find({ author: { $in: seedUserIds } })
    .project({ _id: 1, author: 1 })
    .toArray();

  log(`Found ${seededPosts.length} seeded posts.`);

  let created = 0;
  let skipped = 0;

  for (const post of seededPosts) {
    // Idempotent: skip posts that already have seed comments.
    const existing = await commentsCollection.countDocuments({
      post: post._id,
      isSeed: true,
    });

    if (existing > 0) {
      skipped += 1;
      continue;
    }

    const n = 1 + Math.floor(Math.random() * 3); // 1–3

    // Commenters: seed users other than the post's author.
    const eligible = seedUserIds.filter(
      (id) => String(id) !== String(post.author),
    );
    const commenters = pickN(eligible.length ? eligible : seedUserIds, n);

    const now = Date.now();
    const docs = commenters.map((authorId, i) => {
      let text = pick(SEED_COMMENT_TEXTS);
      if (text.length < minLength) text = "Nice!".padEnd(minLength, "!");
      if (text.length > maxLength) text = text.slice(0, maxLength);

      return {
        post: post._id,
        author: authorId,
        text,
        isSeed: true,
        // Stagger timestamps so they don't all share one instant.
        createdAt: new Date(now - (n - i) * 60000),
        updatedAt: new Date(now - (n - i) * 60000),
      };
    });

    if (docs.length) {
      await commentsCollection.insertMany(docs);
      created += docs.length;
    }
  }

  log("");
  log(
    `Done. Created ${created} seed comment(s) across ${seededPosts.length - skipped} post(s). ` +
      `Skipped ${skipped} already-seeded post(s).`,
  );

  return {
    step: "seedComments",
    seedUsers: seedUserIds.length,
    seededPosts: seededPosts.length,
    commentsCreated: created,
    postsSkipped: skipped,
  };
}

export async function seedComments(req, res) {
  return respond(req, res, async (log) => {
    assertSeedingAllowed(req);
    return runSeedComments(log);
  });
}

export async function runUnseedComments(log = createLogger()) {
  assertDatabaseReady();

  const db = mongoose.connection.db;
  const commentsCollection = db.collection(Comment.collection.name);
  const postsCollection = db.collection(Post.collection.name);

  // Count first, so we can report and (if needed) fix denormalized counts.
  const toRemove = await commentsCollection
    .find({ isSeed: true })
    .project({ _id: 1, post: 1 })
    .toArray();

  if (toRemove.length === 0) {
    log("No seed comments found. Nothing to do.");
    return { step: "unseedComments", commentsDeleted: 0, postsAdjusted: 0 };
  }

  log(`Found ${toRemove.length} seed comment(s).`);

  // Tally how many seed comments each post had, for optional count fixup.
  const perPost = {};
  for (const c of toRemove) {
    const key = String(c.post);
    perPost[key] = (perPost[key] || 0) + 1;
  }

  const result = await commentsCollection.deleteMany({ isSeed: true });
  log(`Deleted ${result.deletedCount} seed comment(s).`);

  // Denormalized-count fixup. Only touches posts that actually HAVE a numeric
  // commentCount, so this is a no-op on schemas without one.
  let fixedPosts = 0;
  for (const [postId, count] of Object.entries(perPost)) {
    try {
      const updated = await postsCollection.updateOne(
        {
          _id: new mongoose.Types.ObjectId(postId),
          commentCount: { $exists: true },
        },
        { $inc: { commentCount: -count } },
      );
      if (updated.modifiedCount) fixedPosts += 1;
    } catch {
      /* invalid id or no such post — skip */
    }
  }

  if (fixedPosts > 0) log(`Adjusted commentCount on ${fixedPosts} post(s).`);
  log("Done.");

  return {
    step: "unseedComments",
    commentsDeleted: result.deletedCount,
    postsAdjusted: fixedPosts,
  };
}

export async function unseedComments(req, res) {
  return respond(req, res, async (log) => {
    assertSeedingAllowed(req);
    assertConfirmed(req);
    return runUnseedComments(log);
  });
}

// ---------------------------------------------------------------------------
// Seed asset removal (Cloudinary)
// ---------------------------------------------------------------------------

// Category 1: everything under the seed prefix, paginating past the
// 500-per-call limit via next_cursor.
async function collectFromPrefix() {
  const publicIds = new Set();
  let nextCursor;

  do {
    const response = await cloudinary.api.resources({
      type: "upload",
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

// delete_resources accepts up to 100 public IDs per call. Returns the IDs that
// came back as not_found so the caller can retry exactly those as another
// resource type instead of resending the whole list.
async function deleteInBatches(publicIds, resourceType) {
  let deleted = 0;
  const notFound = [];

  for (let i = 0; i < publicIds.length; i += 100) {
    const batch = publicIds.slice(i, i + 100);
    const result = await cloudinary.api.delete_resources(batch, {
      type: "upload",
      resource_type: resourceType,
      invalidate: true,
    });

    // result.deleted maps publicId -> "deleted" | "not_found".
    for (const [publicId, value] of Object.entries(result.deleted ?? {})) {
      if (value === "deleted") deleted += 1;
      else notFound.push(publicId);
    }
  }

  return { deleted, notFound };
}

async function deleteFolders(log) {
  let removed = 0;

  for (const folder of FOLDERS_DEEPEST_FIRST) {
    try {
      await cloudinary.api.delete_folder(folder);
      log(`  Deleted folder: ${folder}`);
      removed += 1;
    } catch (error) {
      // Missing or not yet empty. Report and continue rather than aborting.
      const message = error?.error?.message || error?.message || String(error);
      log(`  Skipped folder ${folder}: ${message}`);
    }
  }

  return removed;
}

async function deleteManifest(log) {
  try {
    await fs.unlink(MANIFEST_PATH);
    log(`Deleted manifest: ${MANIFEST_PATH}`);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      log("Manifest already absent — nothing to delete.");
      return false;
    }
    throw error;
  }
}

export async function runRemoveSeedAssets(
  { confirm = false } = {},
  log = createLogger(),
) {
  assertDatabaseReady();
  configureCloudinary();

  const demoUsers = await User.find(demoUserQuery()).lean();
  const userIds = demoUsers.map((user) => user._id);

  log(`Demo users: ${demoUsers.length}`);
  for (const user of demoUsers) {
    log(`  ${user.username ?? "(no username)"} <${user.email}>`);
  }
  log("");

  log(`Scanning Cloudinary prefix "${ASSET_PREFIX}"...`);
  const fromPrefix = await collectFromPrefix();
  log(`  ${fromPrefix.size} asset(s)`);

  log("Reading avatars from demo user documents...");
  const fromUsers = collectFromUsers(demoUsers);
  log(`  ${fromUsers.size} asset(s)`);

  log("Reading images from demo users' posts...");
  const { publicIds: fromPosts, postCount } = await collectFromPosts(userIds);
  log(`  ${fromPosts.size} asset(s) across ${postCount} post(s)`);

  // Union — an asset may appear in more than one source.
  const all = new Set([...fromPrefix, ...fromUsers, ...fromPosts]);
  const outsidePrefix = [...all].filter((id) => !id.startsWith(ASSET_PREFIX));

  log("");
  log(`Total unique assets: ${all.size}`);
  if (outsidePrefix.length > 0) {
    log(
      `  ${outsidePrefix.length} of these live OUTSIDE "${ASSET_PREFIX}" — ` +
        "they were uploaded by demo users through the app, not by the seed script.",
    );
  }

  if (!confirm) {
    log("");
    log("DRY RUN — nothing will be deleted. Send { confirm: true } to delete.");

    for (const id of [...all].sort()) {
      const flag = id.startsWith(ASSET_PREFIX) ? "  " : "! ";
      log(`  ${flag}would delete: ${id}`);
    }

    if (outsidePrefix.length > 0) {
      log("");
      log(
        "  Lines marked ! are outside the seed prefix. Read them before confirming.",
      );
    }

    log("");
    log(`Would also remove folders: ${FOLDERS_DEEPEST_FIRST.join(", ")}`);
    log(`Would also remove manifest: ${MANIFEST_PATH}`);

    return {
      step: "removeSeedAssets",
      dryRun: true,
      demoUsers: demoUsers.length,
      totalAssets: all.size,
      outsidePrefix,
      wouldDelete: [...all].sort(),
    };
  }

  const ids = [...all];
  let imagesDeleted = 0;
  let videosDeleted = 0;
  let stillMissing = [];

  if (ids.length > 0) {
    log("");
    log("Deleting images...");
    const imageResult = await deleteInBatches(ids, "image");
    imagesDeleted = imageResult.deleted;
    stillMissing = imageResult.notFound;

    // Anything not found as an image may be a video. Retry only those IDs —
    // resending the whole list would double the API calls for no benefit.
    if (stillMissing.length > 0) {
      log(`Retrying ${stillMissing.length} not-found ID(s) as video...`);
      const videoResult = await deleteInBatches(stillMissing, "video");
      videosDeleted = videoResult.deleted;
      stillMissing = videoResult.notFound;
    }
  }

  log("Deleting folders...");
  const foldersDeleted = await deleteFolders(log);

  log("Removing local manifest...");
  const manifestRemoved = await deleteManifest(log);

  log("");
  log(`Images deleted  : ${imagesDeleted}`);
  log(`Videos deleted  : ${videosDeleted}`);
  log(`Not found       : ${stillMissing.length}`);
  log(`Folders deleted : ${foldersDeleted}`);
  log(
    manifestRemoved
      ? "Manifest        : deleted"
      : "Manifest        : already absent",
  );

  return {
    step: "removeSeedAssets",
    dryRun: false,
    demoUsers: demoUsers.length,
    totalAssets: all.size,
    imagesDeleted,
    videosDeleted,
    notFound: stillMissing,
    foldersDeleted,
    manifestRemoved,
  };
}

export async function removeSeedAssets(req, res) {
  return respond(req, res, async (log) => {
    assertSeedingAllowed(req);
    // No assertConfirmed here — without confirmation this is a dry run, which is
    // useful on its own and deletes nothing.
    const confirm =
      req?.body?.confirm === true || req?.body?.confirm === "--confirm";
    return runRemoveSeedAssets({ confirm }, log);
  });
}

// ---------------------------------------------------------------------------
// Demo data removal (Mongo)
// ---------------------------------------------------------------------------

export async function runRemoveDemoData(log = createLogger()) {
  assertDatabaseReady();

  const demoUsers = await User.find(demoUserQuery(), {
    _id: 1,
    username: 1,
    email: 1,
  }).lean();

  if (demoUsers.length === 0) {
    log("No demo users found.");
    return { step: "removeDemoData", users: 0 };
  }

  const userIds = demoUsers.map((user) => user._id);
  log(`Found ${demoUsers.length} demo users:`);
  for (const user of demoUsers) log(`  ${user.username} <${user.email}>`);

  const participantsField = resolveField(Conversation, [
    "participants",
    "members",
    "users",
  ]);
  const conversationField = resolveField(Message, [
    "conversation",
    "conversationId",
    "chat",
  ]);
  const commentAuthorField = resolveField(Comment, [
    "author",
    "user",
    "createdBy",
  ]);
  const commentPostField = resolveField(Comment, ["post", "postId"]);
  // Threaded replies are optional — many schemas are flat.
  const commentParentField = optionalField(Comment, [
    "parent",
    "parentComment",
    "parentId",
    "replyTo",
  ]);

  // ----- conversations and messages -----

  // Every conversation a demo user took part in, including one-to-one chats with
  // real users. Those conversations are demo data too — the other side was
  // talking to an account that does not represent a person.
  const conversations = await Conversation.find(
    { [participantsField]: { $in: userIds } },
    { _id: 1 },
  ).lean();

  const conversationIds = conversations.map((conversation) => conversation._id);

  // Delete messages by CONVERSATION, not by sender. Deleting only the demo
  // users' own messages would leave real users' replies orphaned, pointing at a
  // conversation that no longer exists.
  const messageResult = conversationIds.length
    ? await Message.deleteMany({
        [conversationField]: { $in: conversationIds },
      })
    : { deletedCount: 0 };

  const conversationResult = conversationIds.length
    ? await Conversation.deleteMany({ _id: { $in: conversationIds } })
    : { deletedCount: 0 };

  // Any stragglers: messages sent by a demo user in a conversation that was
  // somehow not matched above. An empty $or is rejected by Mongo, so only run
  // this when at least one sender-ish field actually exists on the schema.
  const senderClauses = ["sender", "author", "from"]
    .filter((name) => Message.schema.path(name))
    .map((name) => ({ [name]: { $in: userIds } }));

  const orphanMessageResult = senderClauses.length
    ? await Message.deleteMany({ $or: senderClauses })
    : { deletedCount: 0 };

  // ----- posts and comments -----

  // Collect post IDs BEFORE deleting the posts, so comments on them can still be
  // found.
  const demoPosts = await Post.find(
    { author: { $in: userIds } },
    { _id: 1 },
  ).lean();
  const postIds = demoPosts.map((post) => post._id);

  // Two directions, both necessary:
  //   1. Comments written BY a demo user — including on real users' posts.
  //   2. Comments written by anyone ON a demo user's post — that post is being
  //      deleted, so leaving these behind strands them.
  const commentResult = await Comment.deleteMany({
    $or: [
      { [commentAuthorField]: { $in: userIds } },
      ...(postIds.length ? [{ [commentPostField]: { $in: postIds } }] : []),
    ],
  });

  // Threaded replies: a real user's reply to a demo user's comment on a real
  // post survives the pass above, because neither its author nor its post is
  // demo data. Sweep until no comment points at a missing parent.
  //
  // Bounded so a cycle in the data cannot spin forever — a thread deeper than 20
  // levels is a data problem worth seeing rather than silently grinding on.
  let orphanCommentCount = 0;
  if (commentParentField) {
    for (let pass = 0; pass < 20; pass += 1) {
      const withParent = await Comment.find(
        { [commentParentField]: { $ne: null } },
        { _id: 1, [commentParentField]: 1 },
      ).lean();

      if (withParent.length === 0) break;

      const parentIds = [
        ...new Set(withParent.map((c) => String(c[commentParentField]))),
      ];
      const existing = await Comment.find(
        { _id: { $in: parentIds } },
        { _id: 1 },
      ).lean();
      const existingIds = new Set(existing.map((c) => String(c._id)));

      const orphanIds = withParent
        .filter((c) => !existingIds.has(String(c[commentParentField])))
        .map((c) => c._id);

      if (orphanIds.length === 0) break;

      const result = await Comment.deleteMany({ _id: { $in: orphanIds } });
      orphanCommentCount += result.deletedCount;
    }
  }

  const postResult = postIds.length
    ? await Post.deleteMany({ _id: { $in: postIds } })
    : { deletedCount: 0 };

  // Users last, so a crash mid-run leaves them findable for a re-run rather than
  // orphaning everything above.
  const userResult = await User.deleteMany({ _id: { $in: userIds } });

  log("");
  log("Demo data removed.");
  log(`Conversations deleted : ${conversationResult.deletedCount}`);
  log(`Messages deleted      : ${messageResult.deletedCount}`);
  log(`Orphan messages       : ${orphanMessageResult.deletedCount}`);
  log(`Comments deleted      : ${commentResult.deletedCount}`);
  log(`Orphan replies        : ${orphanCommentCount}`);
  log(`Posts deleted         : ${postResult.deletedCount}`);
  log(`Users deleted         : ${userResult.deletedCount}`);

  return {
    step: "removeDemoData",
    conversations: conversationResult.deletedCount,
    messages: messageResult.deletedCount,
    orphanMessages: orphanMessageResult.deletedCount,
    comments: commentResult.deletedCount,
    orphanReplies: orphanCommentCount,
    posts: postResult.deletedCount,
    users: userResult.deletedCount,
  };
}

export async function removeData(req, res) {
  return respond(req, res, async (log) => {
    assertSeedingAllowed(req);
    assertConfirmed(req);
    return runRemoveDemoData(log);
  });
}
// localpulse/server/src/controllers/adminSeedController.js
//
// ─────────────────────────────────────────────────────────────────────────────
// REPLACEMENT for the "Orchestration" section at the bottom of the controller.
// Delete everything from the `// --- Orchestration ---` comment onward and
// paste this in its place. Also add this import at the top of the file, beside
// the existing imports:
//
//   import {
//     startJob,
//     getJob,
//     listJobs,
//     requestCancel,
//     serialiseJob,
//     JobConflictError,
//   } from "../lib/seedJobs.js";
//
// Nothing above the orchestration section changes. The run* functions already
// take a `log` function as their last argument, which is exactly what the job
// runner hands them.
// ─────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Orchestration (background jobs)
// ---------------------------------------------------------------------------

// The single-step endpoints stay synchronous — each finishes well inside a
// normal request. Only up/down run long enough to need a job, because they
// chain every step into one call.

function failFast(res, error) {
  const status =
    error?.status || (error instanceof HttpError ? error.status : 500);
  if (status >= 500) console.error("Seed job could not start:", error);
  return res.status(status).json({
    ok: false,
    error: error?.message || "Could not start job.",
  });
}

export function up(req, res) {
  try {
    assertSeedingAllowed(req);

    const { lat, lng, posts } = req.body ?? {};

    const job = startJob("up", async ({ log, checkCancelled, setStep }) => {
      const steps = [];

      // Strictly sequential. seedDemoData reads the manifest that
      // uploadSeedAssets writes, and seedComments needs the users that
      // seedDemoData creates.
      setStep("Uploading seed assets");
      log("=== Step 1/3: upload seed assets ===");
      steps.push(await runUploadSeedAssets(log));
      checkCancelled();

      setStep("Seeding users and posts");
      log("");
      log("=== Step 2/3: seed demo data ===");
      steps.push(await runSeedDemoData({ lat, lng, posts }, log));
      checkCancelled();

      setStep("Seeding comments");
      log("");
      log("=== Step 3/3: seed comments ===");
      steps.push(await runSeedComments(log));

      log("");
      log(`Demo password: ${DEMO_PASSWORD}`);

      return { operation: "up", steps };
    });

    return res
      .status(202)
      .json({ ok: true, jobId: job.id, status: job.status });
  } catch (error) {
    return failFast(res, error);
  }
}

export function down(req, res) {
  try {
    assertSeedingAllowed(req);

    const confirm =
      req?.body?.confirm === true || req?.body?.confirm === "--confirm";

    const job = startJob("down", async ({ log, checkCancelled, setStep }) => {
      // Dry run unless confirmed — and in a dry run only the asset sweep is
      // safe to execute, since it is the only step that reports without
      // writing.
      if (!confirm) {
        setStep("Dry run");
        log("=== DRY RUN — send { confirm: true } to delete ===");
        const preview = await runRemoveSeedAssets({ confirm: false }, log);
        return { operation: "down", dryRun: true, steps: [preview] };
      }

      const steps = [];

      // Order matters: removeSeedAssets reads the demo users and their posts to
      // find Cloudinary IDs, so it must finish before removeDemoData deletes
      // them.
      setStep("Removing seed assets");
      log("=== Step 1/3: remove seed assets ===");
      steps.push(await runRemoveSeedAssets({ confirm: true }, log));
      checkCancelled();

      setStep("Removing seed comments");
      log("");
      log("=== Step 2/3: unseed comments ===");
      steps.push(await runUnseedComments(log));
      checkCancelled();

      setStep("Removing demo data");
      log("");
      log("=== Step 3/3: remove demo data ===");
      steps.push(await runRemoveDemoData(log));

      return { operation: "down", dryRun: false, steps };
    });

    return res
      .status(202)
      .json({ ok: true, jobId: job.id, status: job.status });
  } catch (error) {
    return failFast(res, error);
  }
}

// ---------------------------------------------------------------------------
// Job status
// ---------------------------------------------------------------------------

export function getSeedJob(req, res) {
  try {
    assertSeedingAllowed(req);

    const job = getJob(req.params.id);
    if (!job) {
      throw new HttpError(
        404,
        "Job not found. It may have expired or the API restarted.",
      );
    }

    // ?since=N returns only log lines the client has not seen yet.
    return res
      .status(200)
      .json({ ok: true, job: serialiseJob(job, req.query.since) });
  } catch (error) {
    return failFast(res, error);
  }
}

export function listSeedJobs(req, res) {
  try {
    assertSeedingAllowed(req);
    return res.status(200).json({ ok: true, jobs: listJobs() });
  } catch (error) {
    return failFast(res, error);
  }
}

export function cancelSeedJob(req, res) {
  try {
    assertSeedingAllowed(req);

    const job = requestCancel(req.params.id);
    if (!job) throw new HttpError(404, "Job not found.");

    // Cooperative: the orchestrator checks between steps, so an in-flight
    // Cloudinary upload or Mongo write finishes before the job stops.
    return res
      .status(202)
      .json({ ok: true, job: serialiseJob(job, job.log.length) });
  } catch (error) {
    return failFast(res, error);
  }
}
