// localpulse/server/src/routes/admin.routes.js
import { Router } from "express";
import {
  stats,
  listUsers,
  setBanned,
  listReports,
  resolveReport,
  adminGetMessages,
  listPosts as adminListPosts,
  deletePost as adminDeletePost,
} from "../controllers/adminController.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();

router.get("/stats", requireAuth, requireAdmin, stats);
router.get("/users", requireAuth, requireAdmin, listUsers);
router.patch("/users/:id/ban", requireAuth, requireAdmin, setBanned);
router.get("/posts", requireAuth, requireAdmin, adminListPosts);
router.delete("/posts/:id", requireAuth, requireAdmin, adminDeletePost);
router.get("/reports", requireAuth, requireAdmin, listReports);
router.patch("/reports/:id", requireAuth, requireAdmin, resolveReport);

// Full thread around a reported message, unfiltered by hiddenFor. This is a
// privileged read of a private conversation — requireAdmin is the only gate,
// and there is deliberately no participant check, because a moderator cannot
// judge one line without what surrounds it.
//
// Link to it ONLY from a report. Reachable from a user detail page or a search
// box, it stops being a moderation tool and becomes a general-purpose DM
// viewer for anyone holding the admin flag.
router.get(
  "/conversations/:id/messages",
  requireAuth,
  requireAdmin,
  adminGetMessages,
);

export default router;
