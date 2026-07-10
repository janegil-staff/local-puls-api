// localpulse/server/src/controllers/uploadController.js
import { uploadImage } from '../lib/cloudinary.js';

// Expects multer to have put the file on req.file (memory storage).
export async function uploadImageHandler(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    // { url, publicId } — the client stores both, so deletion doesn't have to
    // reverse-engineer the id out of the URL later.
    const { url, publicId } = await uploadImage(req.file.buffer, req.file.mimetype);
    return res.json({ url, publicId });
  } catch (err) {
    console.error('upload error', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
}