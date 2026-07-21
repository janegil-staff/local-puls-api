// localpulse/server/src/routes/notification.routes.js
import { Router } from 'express';
import {
  listNotifications, unreadCount, markAllRead, registerPushToken, removePushToken,
} from '../controllers/notificationController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, listNotifications);
router.get('/unread-count', requireAuth, unreadCount);
router.post('/read', requireAuth, markAllRead);

// Push token registration (mounted separately in index)
export const pushRouter = Router();
pushRouter.post('/register', requireAuth, registerPushToken);
pushRouter.post('/remove', requireAuth, removePushToken);

export default router;
