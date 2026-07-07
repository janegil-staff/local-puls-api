// localpulse/server/src/controllers/uploadController.js
import { uploadImage } from '../lib/cloudinary.js';

// Expects multer to have put the file on req.file (memory storage).
export async function uploadImageHandler(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    const url = await uploadImage(req.file.buffer, req.file.mimetype);
    return res.json({ url });
  } catch (err) {
    console.error('upload error', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
}