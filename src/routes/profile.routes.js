// localpulse/server/src/routes/profile.routes.js
import { Router } from 'express';
import {
  getMe, updateProfile, updatePreferences, updateLocation, deleteAccount,
} from '../controllers/profileController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, getMe);
router.patch('/', requireAuth, updateProfile);
router.patch('/preferences', requireAuth, updatePreferences);
router.patch('/location', requireAuth, updateLocation);
router.delete('/', requireAuth, deleteAccount); // App Store 5.1.1

export default router;
