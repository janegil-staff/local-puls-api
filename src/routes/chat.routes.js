// localpulse/server/src/routes/chat.routes.js
import { Router } from 'express';
import {
  listConversations,
  listRequests,
  openConversation,
  acceptConversation,
  getMessages,
  sendMessage,
  chatUnreadCount,
  markRead,
} from '../controllers/chatController.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

router.get('/conversations', requireAuth, listConversations);
router.get('/requests', requireAuth, listRequests);
router.get('/unread-count', requireAuth, chatUnreadCount);

router.post('/conversations/:userId', requireAuth, openConversation);
router.post('/conversations/:id/accept', requireAuth, acceptConversation);

router.get('/conversations/:id/messages', requireAuth, getMessages);
router.post(
  '/conversations/:id/messages',
  requireAuth,
  validate({ body: { text: { type: 'string', min: 1, max: 2000 } } }),
  sendMessage
);

router.post('/conversations/:id/read', requireAuth, markRead);

export default router;
