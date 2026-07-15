// localpulse/server/src/routes/index.js
import { Router } from 'express';
import multer from 'multer';

import {
  getMe, updateProfile, updatePreferences, updateLocation, deleteAccount,
} from '../controllers/profileController.js';
import { getDeck } from '../controllers/discoveryController.js';
import { swipe, listMatches, unmatch } from '../controllers/matchController.js';
import { createPost, getFeed, toggleLike } from '../controllers/postController.js';
import { listComments, addComment, deleteComment } from '../controllers/commentController.js';
import { getProfile, follow, unfollow, followingFeed } from '../controllers/userController.js';
import { toggleSave, listSaved } from '../controllers/savedController.js';
import { uploadImageHandler } from '../controllers/uploadController.js';
import {
  listNotifications, unreadCount, markAllRead, registerPushToken, removePushToken,
} from '../controllers/notificationController.js';
import {
  reportPost, reportUser, blockUser, unblockUser, listBlocked,
} from '../controllers/moderationController.js';
import {
  stats, listUsers, setBanned, listReports, resolveReport,
  listPosts as adminListPosts, deletePost as adminDeletePost,
} from '../controllers/adminController.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { validate } from '../middleware/validate.js';
import { authLimiter } from '../middleware/rateLimit.js';
// update the import:
import { listConversations, listRequests, openConversation, acceptConversation, getMessages, chatUnreadCount, markRead } from '../controllers/chatController.js';
import { geocode, setLocation, setBrowseLocation } from '../controllers/locationController.js';
import {
  register, login, me,
  verifyEmail, resendVerification,
  requestPinReset, resetPin,
  changePin,
} from '../controllers/authController.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ── Auth ──────────────────────────────────────────────
router.post(
  '/auth/register',
  authLimiter,
  validate({
    body: {
      email: { required: true, type: 'string', isEmail: true },
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

// ── Profile / preferences / account ───────────────────
router.get('/me', requireAuth, getMe);
router.patch('/me', requireAuth, updateProfile);
router.patch('/me/preferences', requireAuth, updatePreferences);
router.patch('/me/location', requireAuth, updateLocation);
router.delete('/me', requireAuth, deleteAccount); // App Store 5.1.1

// ── Discovery + matching ──────────────────────────────
router.get('/discovery', requireAuth, getDeck);
router.post('/swipe/:userId', requireAuth, swipe);
router.get('/matches', requireAuth, listMatches);
router.delete('/matches/:id', requireAuth, unmatch);

// ── Feed / posts (public social side) ─────────────────
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

// ── Public user profile + social graph ────────────────
router.get('/users/:username', optionalAuth, getProfile);
router.post('/users/:id/follow', requireAuth, follow);
router.delete('/users/:id/follow', requireAuth, unfollow);

// ── Chat (gated behind active match) ──────────────────
router.get('/chat/conversations', requireAuth, listConversations);
router.get('/chat/requests', requireAuth, listRequests);
router.post('/chat/conversations/:userId', requireAuth, openConversation);
router.post('/chat/conversations/:id/accept', requireAuth, acceptConversation);
router.get('/chat/conversations/:id/messages', requireAuth, getMessages);
router.get('/chat/unread-count', requireAuth, chatUnreadCount);
router.post('/chat/conversations/:id/read', requireAuth, markRead);
router.get('/chat/unread-count', requireAuth, chatUnreadCount);
router.post('/chat/conversations/:id/read', requireAuth, markRead);

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

// add these routes with the other /chat routes:
router.get('/chat/unread-count', requireAuth, chatUnreadCount);
router.post('/chat/conversations/:id/read', requireAuth, markRead);

router.get('/geocode', requireAuth, geocode);
router.post('/location', requireAuth, setLocation);
router.post('/browse-location', requireAuth, setBrowseLocation);

router.get('/auth/verify/:token', verifyEmail);
router.post('/auth/resend-verification', requireAuth, resendVerification);

router.post('/auth/forgot-pin', authLimiter, requestPinReset);
router.post('/auth/reset-pin', authLimiter, resetPin);

router.post('/auth/change-pin', requireAuth, authLimiter, changePin);



export default router;
