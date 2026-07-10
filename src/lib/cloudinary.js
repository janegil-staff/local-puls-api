// localpulse/server/src/lib/cloudinary.js
//
// Image storage via Cloudinary, with a local-disk fallback for dev when
// Cloudinary isn't configured.
//
// uploadImage() now returns { url, publicId } rather than a bare URL. The
// publicId is what Cloudinary's destroy API takes; deriving it from the
// delivery URL after the fact (publicIdFromUrl, below) works but breaks on
// transformed URLs, so we capture it at upload time and store it alongside.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';

const cloudinaryConfigured = Boolean(
  config.cloudinary.cloudName && config.cloudinary.apiKey && config.cloudinary.apiSecret
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DIR = path.resolve(__dirname, '../../uploads');

// Lazily import + configure the SDK only when credentials exist.
let cloudinary = null;
async function getCloudinary() {
  if (!cloudinary) {
    const mod = await import('cloudinary');
    cloudinary = mod.v2;
    cloudinary.config({
      cloud_name: config.cloudinary.cloudName,
      api_key: config.cloudinary.apiKey,
      api_secret: config.cloudinary.apiSecret,
      secure: true,
    });
  }
  return cloudinary;
}

// Upload a buffer. Returns { url, publicId }. In the local-disk fallback,
// publicId is null — there's nothing to destroy remotely.
export async function uploadImage(buffer, contentType = 'image/jpeg') {
  const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

  if (cloudinaryConfigured) {
    const cld = await getCloudinary();
    // upload_stream takes a buffer; wrap it in a promise.
    return new Promise((resolve, reject) => {
      const stream = cld.uploader.upload_stream(
        {
          folder: config.cloudinary.folder || 'nearby',
          public_id: filename,
          resource_type: 'image',
          // To enable moderation later, add: moderation: 'aws_rek' (or 'webpurify'),
          // then check result.moderation[0].status before treating the image as live.
        },
        (err, result) => {
          if (err) return reject(err);
          // result.public_id is the FULL id including the folder prefix
          // ("nearby/1720…-a1b2c3"), which is what destroy() expects — not the
          // bare `filename` we passed in.
          resolve({ url: result.secure_url, publicId: result.public_id });
        }
      );
      stream.end(buffer);
    });
  }

  // ── Local disk fallback (dev) ──
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const localName = `${filename}.${ext}`;
  fs.writeFileSync(path.join(LOCAL_DIR, localName), buffer);
  const base = config.publicUrl || `http://localhost:${config.port}`;
  return { url: `${base}/uploads/${localName}`, publicId: null };
}

// https://res.cloudinary.com/<cloud>/image/upload/v1234567890/nearby/abc123.jpg
//                                                             ^^^^^^^^^^^^^^ public_id
//
// Only for LEGACY rows written before uploadImage returned the publicId. New
// code should never call this — it fails on transformed URLs, and the id is
// already stored. Kept so the migration script and destroyImages() can salvage
// what they can from old data.
export function publicIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname !== 'res.cloudinary.com') return null;

    const parts = pathname.split('/').filter(Boolean);
    const uploadAt = parts.indexOf('upload');
    if (uploadAt === -1) return null;

    let rest = parts.slice(uploadAt + 1);
    // Drop the version segment if present.
    if (rest[0] && /^v\d+$/.test(rest[0])) rest = rest.slice(1);
    if (rest.length === 0) return null;

    const joined = rest.join('/');
    return joined.replace(/\.[^./]+$/, ''); // strip extension
  } catch {
    return null;
  }
}

// Best-effort bulk delete by public_id. Never throws: an account deletion must
// not fail because Cloudinary was slow or an id was already gone. Orphaned
// assets are a storage cost, not a correctness bug.
//
// Entries that are null (local-disk uploads, or legacy rows whose URL wouldn't
// parse) are skipped. Nothing to destroy remotely.
export async function destroyImages(publicIds) {
  if (!cloudinaryConfigured) return { deleted: 0 };

  const ids = [...new Set((publicIds || []).filter(Boolean))];
  if (ids.length === 0) return { deleted: 0 };

  const cld = await getCloudinary();

  // delete_resources caps at 100 ids per call.
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));

  let deleted = 0;
  for (const chunk of chunks) {
    try {
      await cld.api.delete_resources(chunk);
      deleted += chunk.length;
    } catch (err) {
      console.error('cloudinary delete failed', err?.message ?? err);
    }
  }
  return { deleted };
}

// Convenience for the legacy paths that still hold bare URLs
// (Post.imageUrl, Message.imageUrl). Parses, then destroys.
export async function destroyImagesByUrl(urls) {
  return destroyImages((urls || []).map(publicIdFromUrl));
}

export const usingLocalStorage = !cloudinaryConfigured;