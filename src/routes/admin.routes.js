// localpulse/server/src/routes/admin.routes.js
import { Router } from "express";
import {
  stats,
  listUsers,
  setBanned,
  listReports,
  resolveReport,
  adminGetMessages,
  adminListHiddenMessages,
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

// Messages a participant has hidden from their own view — "deleted messages"
// in the admin UI. Hiding never modifies the document, so the original text is
// returned. Listed BEFORE the /conversations route only for readability; the
// paths do not overlap.
router.get(
  "/messages/hidden",
  requireAuth,
  requireAdmin,
  adminListHiddenMessages,
);

// Full thread around a reported message, UNFILTERED by hiddenFor. A privileged
// read of a private conversation: requireAdmin is the only gate, and there is
// deliberately no participant check, because a moderator cannot judge one line
// without what surrounds it.
router.get(
  "/conversations/:id/messages",
  requireAuth,
  requireAdmin,
  adminGetMessages,
);

export default router;
