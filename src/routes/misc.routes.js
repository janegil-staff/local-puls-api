// localpulse/server/src/routes/misc.routes.js
import { Router } from 'express';
import multer from 'multer';
import { geocode, setLocation, setBrowseLocation } from '../controllers/locationController.js';
import { uploadImageHandler } from '../controllers/uploadController.js';
import { reportPost } from '../controllers/moderationController.js';
import { listBlocked } from '../controllers/moderationController.js';
import { deleteComment } from '../controllers/commentController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// Location
router.get('/geocode', requireAuth, geocode);
router.post('/location', requireAuth, setLocation);
router.post('/browse-location', requireAuth, setBrowseLocation);

// Uploads
router.post('/upload', requireAuth, upload.single('image'), uploadImageHandler);

// Standalone moderation endpoints that don't nest cleanly elsewhere
router.post('/posts/:postId/report', requireAuth, reportPost);
router.get('/blocks', requireAuth, listBlocked);
router.delete('/comments/:id', requireAuth, deleteComment);

export default router;
