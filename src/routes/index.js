// localpulse/server/src/routes/index.js
import { Router } from 'express';
import multer from 'multer';
import { register, login, me } from '../controllers/authController.js';
import { createPost, getFeed, toggleLike } from '../controllers/postController.js';
import { listComments, addComment, deleteComment } from '../controllers/commentController.js';
import {
  getProfile, follow, unfollow, followingFeed, updateProfile,
} from '../controllers/userController.js';
import {
  listConversations, openConversation, getMessages,
} from '../controllers/chatController.js';
import { uploadImageHandler } from '../controllers/uploadController.js';
import {
  listNotifications, unreadCount, markAllRead, registerPushToken, removePushToken,
} from '../controllers/notificationController.js';
import {
  reportPost, reportUser, blockUser, unblockUser, listBlocked,
} from '../controllers/moderationController.js';
import { toggleSave, listSaved } from '../controllers/savedController.js';
import {
  stats, listUsers, setBanned, listPosts as adminListPosts, deletePost as adminDeletePost,
  listReports, resolveReport,
} from '../controllers/adminController.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { validate } from '../middleware/validate.js';
import { authLimiter } from '../middleware/rateLimit.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ── Auth (rate-limited) ───────────────────────────────
router.post(
  '/auth/register',
  authLimiter,
  validate({
    body: {
      username: { required: true, type: 'string', min: 3, max: 24 },
      email: { required: true, type: 'string', isEmail: true },
      password: { required: true, type: 'string', min: 6 },
    },
  }),
  register
);
router.post(
  '/auth/login',
  authLimiter,
  validate({ body: { emailOrUsername: { required: true }, password: { required: true } } }),
  login
);
router.get('/auth/me', requireAuth, me);

// ── Posts ─────────────────────────────────────────────
router.post(
  '/posts',
  requireAuth,
  validate({ body: { text: { required: true, type: 'string', min: 1, max: 1000 } } }),
  createPost
);
router.get('/posts/feed', optionalAuth, getFeed);
router.get('/posts/following', requireAuth, followingFeed);
router.get('/posts/saved', requireAuth, listSaved);
router.post('/posts/:id/like', requireAuth, toggleLike);
router.post('/posts/:postId/save', requireAuth, toggleSave);

// ── Comments ──────────────────────────────────────────
router.get('/posts/:postId/comments', listComments);
router.post(
  '/posts/:postId/comments',
  requireAuth,
  validate({ body: { text: { required: true, type: 'string', min: 1, max: 500 } } }),
  addComment
);
router.delete('/comments/:id', requireAuth, deleteComment);

// ── Users / social graph ──────────────────────────────
router.get('/users/:username', optionalAuth, getProfile);
router.patch('/users/me', requireAuth, updateProfile);
router.post('/users/:id/follow', requireAuth, follow);
router.delete('/users/:id/follow', requireAuth, unfollow);

// ── Chat ──────────────────────────────────────────────
router.get('/chat/conversations', requireAuth, listConversations);
router.post('/chat/conversations/:userId', requireAuth, openConversation);
router.get('/chat/conversations/:id/messages', requireAuth, getMessages);

// ── Notifications + push ──────────────────────────────
router.get('/notifications', requireAuth, listNotifications);
router.get('/notifications/unread-count', requireAuth, unreadCount);
router.post('/notifications/read', requireAuth, markAllRead);
router.post('/push/register', requireAuth, registerPushToken);
router.post('/push/remove', requireAuth, removePushToken);

// ── Moderation (user-facing) ──────────────────────────
router.post('/posts/:postId/report', requireAuth, reportPost);
router.post('/users/:userId/report', requireAuth, reportUser);
router.post('/users/:userId/block', requireAuth, blockUser);
router.delete('/users/:userId/block', requireAuth, unblockUser);
router.get('/blocks', requireAuth, listBlocked);

// ── Uploads ───────────────────────────────────────────
router.post('/upload', requireAuth, upload.single('image'), uploadImageHandler);

// ── Admin ─────────────────────────────────────────────
router.get('/admin/stats', requireAuth, requireAdmin, stats);
router.get('/admin/users', requireAuth, requireAdmin, listUsers);
router.patch('/admin/users/:id/ban', requireAuth, requireAdmin, setBanned);
router.get('/admin/posts', requireAuth, requireAdmin, adminListPosts);
router.delete('/admin/posts/:id', requireAuth, requireAdmin, adminDeletePost);
router.get('/admin/reports', requireAuth, requireAdmin, listReports);
router.patch('/admin/reports/:id', requireAuth, requireAdmin, resolveReport);

export default router;
