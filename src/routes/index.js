// localpulse/server/src/routes/index.js
import { Router } from 'express';

import authRoutes from './auth.routes.js';
import profileRoutes from './profile.routes.js';
import discoveryRoutes from './discovery.routes.js';
import postRoutes from './post.routes.js';
import userRoutes from './user.routes.js';
import chatRoutes from './chat.routes.js';
import notificationRoutes, { pushRouter } from './notification.routes.js';
import adminRoutes from './admin.routes.js';
import miscRoutes from './misc.routes.js';

const router = Router();
router.use('/posts', postRoutes);
router.use('/auth', authRoutes);
router.use('/me', profileRoutes);
router.use('/', discoveryRoutes);      // /discovery, /swipe, /matches

router.use('/users', userRoutes);
router.use('/chat', chatRoutes);
router.use('/notifications', notificationRoutes);
router.use('/push', pushRouter);
router.use('/admin', adminRoutes);
router.use('/', miscRoutes);           // /geocode, /location, /upload, /blocks, etc.

export default router;
