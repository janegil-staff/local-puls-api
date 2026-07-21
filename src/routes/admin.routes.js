// localpulse/server/src/routes/admin.routes.js
import { Router } from 'express';
import {
  stats, listUsers, setBanned, listReports, resolveReport,
  listPosts as adminListPosts, deletePost as adminDeletePost,
} from '../controllers/adminController.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

const router = Router();

router.get('/stats', requireAuth, requireAdmin, stats);
router.get('/users', requireAuth, requireAdmin, listUsers);
router.patch('/users/:id/ban', requireAuth, requireAdmin, setBanned);
router.get('/posts', requireAuth, requireAdmin, adminListPosts);
router.delete('/posts/:id', requireAuth, requireAdmin, adminDeletePost);
router.get('/reports', requireAuth, requireAdmin, listReports);
router.patch('/reports/:id', requireAuth, requireAdmin, resolveReport);

export default router;
