// localpulse/server/src/lib/cloudinary.js
// Image storage via Cloudinary, with a local-disk fallback for dev when
// Cloudinary isn't configured. Same uploadImage(buffer, contentType) signature
// as before, so nothing downstream changes.
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

// Upload a buffer, return its public (https) URL.
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
          resolve(result.secure_url);
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
  return `${base}/uploads/${localName}`;
}

export const usingLocalStorage = !cloudinaryConfigured;