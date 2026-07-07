// localpulse/server/src/lib/spaces.js
// DigitalOcean Spaces is S3-compatible; use the AWS SDK v3 S3 client.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import { config } from '../config/index.js';

const s3 = new S3Client({
  region: config.spaces.region,
  endpoint: config.spaces.endpoint,
  forcePathStyle: false,
  credentials: { accessKeyId: config.spaces.key, secretAccessKey: config.spaces.secret },
});

// Upload a buffer and return its public URL.
export async function uploadImage(buffer, contentType = 'image/jpeg') {
  const ext = contentType.split('/')[1] || 'jpg';
  const key = `uploads/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: config.spaces.bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ACL: 'public-read',
  }));
  return `${config.spaces.endpoint}/${config.spaces.bucket}/${key}`;
}
