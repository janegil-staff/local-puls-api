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

// Open (or re-open) a conversation with a user. NOTE: :userId — distinct path from send.
router.post('/conversations/:userId', requireAuth, openConversation);
router.post('/conversations/:id/accept', requireAuth, acceptConversation);

// Messages: read + write. The write route was previously MISSING.
router.get('/conversations/:id/messages', requireAuth, getMessages);
router.post(
  '/conversations/:id/messages',
  requireAuth,
  validate({ body: { text: { required: true, type: 'string', min: 1, max: 2000 } } }),
  sendMessage
);

router.get('/unread-count', requireAuth, chatUnreadCount);
router.post('/conversations/:id/read', requireAuth, markRead);

export default router;
