// localpulse/server/src/lib/spaces.js
// Image storage. Uses DigitalOcean Spaces (S3-compatible) when credentials are
// configured; otherwise falls back to local disk so uploads work in dev with
// zero cloud setup.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';

const spacesConfigured = Boolean(config.spaces.key && config.spaces.secret);

// Local fallback directory (served statically by the server — see server.js).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DIR = path.resolve(__dirname, '../../uploads');

// Lazily create the S3 client only if Spaces is configured.
let s3 = null;
async function getS3() {
  if (!s3) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    s3 = new S3Client({
      region: config.spaces.region,
      endpoint: config.spaces.endpoint,
      forcePathStyle: false,
      credentials: { accessKeyId: config.spaces.key, secretAccessKey: config.spaces.secret },
    });
  }
  return s3;
}

// Upload a buffer, return its public URL.
export async function uploadImage(buffer, contentType = 'image/jpeg') {
  const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;

  if (spacesConfigured) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await getS3();
    const key = `uploads/${filename}`;
    await client.send(new PutObjectCommand({
      Bucket: config.spaces.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: 'public-read',
    }));
    return `${config.spaces.endpoint}/${config.spaces.bucket}/${key}`;
  }

  // ── Local disk fallback ──
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_DIR, filename), buffer);
  // Served at /uploads/<filename> (see static route in server.js).
  const base = config.publicUrl || `http://localhost:${config.port}`;
  return `${base}/uploads/${filename}`;
}

export const usingLocalStorage = !spacesConfigured;