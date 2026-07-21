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

// both web and mobile).
router.get('/conversations/:id/messages', requireAuth, getMessages);
router.post(
  '/conversations/:id/messages',
  requireAuth,
  validate({ body: { text: { type: 'string', min: 1, max: 2000 } } }),
  sendMessage
);
// Lists
router.get('/conversations', requireAuth, listConversations);
router.get('/requests', requireAuth, listRequests);
router.get('/unread-count', requireAuth, chatUnreadCount);

// Open (or re-open) a conversation with a user. NOTE: :userId — a distinct
// path segment from the message routes below, so it never collides with :id.
router.post('/conversations/:userId', requireAuth, openConversation);

// Accept a pending request (recipient only).
router.post('/conversations/:id/accept', requireAuth, acceptConversation);


// Mark a conversation's messages as read.
router.post('/conversations/:id/read', requireAuth, markRead);

export default router;