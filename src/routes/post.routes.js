// localpulse/server/src/routes/post.routes.js
import { Router } from 'express';
import { createPost, getFeed, toggleLike } from '../controllers/postController.js';
import { listComments, addComment, deleteComment } from '../controllers/commentController.js';
import { toggleSave, listSaved } from '../controllers/savedController.js';
import { followingFeed } from '../controllers/userController.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

router.post(
  '/',
  requireAuth,
  validate({ body: { text: { required: true, type: 'string', min: 1, max: 1000 } } }),
  createPost
);
router.get('/feed', optionalAuth, getFeed);
router.get('/following', requireAuth, followingFeed);
router.get('/saved', requireAuth, listSaved);
router.post('/:id/like', requireAuth, toggleLike);
router.post('/:postId/save', requireAuth, toggleSave);

// Comments (nested under posts)
router.get('/:postId/comments', listComments);
router.post(
  '/:postId/comments',
  requireAuth,
  validate({ body: { text: { required: true, type: 'string', min: 1, max: 500 } } }),
  addComment
);

export default router;
