// localpulse/server/src/lib/cloudinary.js
//
// Deletion helpers. The app stores full delivery URLs (photos[], Post.imageUrl,
// Message.imageUrl), but Cloudinary's destroy API takes a public_id — so we
// parse it back out. Storing the public_id alongside the URL at upload time
// would be more robust; this exists because we didn't.
import { v2 as cloudinary } from 'cloudinary';
import { config } from '../config/index.js';

cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
});

// https://res.cloudinary.com/<cloud>/image/upload/v1234567890/nearby/abc123.jpg
//                                                             ^^^^^^^^^^^^^^ public_id
// The version segment (v…) is optional, and transformations may appear before
// it. Everything after the version, minus the extension, is the public_id.
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

// Best-effort bulk delete. Never throws: an account deletion must not fail
// because Cloudinary was slow or a public_id was already gone. Orphaned assets
// are a storage cost, not a correctness bug.
export async function destroyImages(urls) {
  const ids = [...new Set((urls || []).map(publicIdFromUrl).filter(Boolean))];
  if (ids.length === 0) return { deleted: 0 };

  // delete_resources caps at 100 ids per call.
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));

  let deleted = 0;
  for (const chunk of chunks) {
    try {
      await cloudinary.api.delete_resources(chunk);
      deleted += chunk.length;
    } catch (err) {
      console.error('cloudinary delete failed', err?.message ?? err);
    }
  }
  return { deleted };
}