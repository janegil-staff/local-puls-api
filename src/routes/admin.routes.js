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
  adminListRemovedMessages,
  adminRemoveMessage,
  adminRestoreMessage,
  listPosts as adminListPosts,
  deletePost as adminDeletePost,
} from "../controllers/adminController.js";
import {
  setUserRole,
  listRoleChanges,
  listAllRoleChanges,
} from "../controllers/adminRolesController.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { adminListRetractedMessages } from "../controllers/adminRetractedController.js";
import { requireModerator } from "../middleware/requireModerator.js";

const router = Router();

// Two gates, and the difference is deliberate:
//
//   requireAdmin      — account actions. Bans, roles, the user list (which
//                       carries email addresses), and stats.
//   requireModerator  — content actions. Reports, posts, and the message
//                       surfaces needed to judge a report. Admins pass this
//                       too; the middleware allows both roles.
//
// Moderators act on content, admins act on accounts. A moderator who concludes
// an account should be banned has to escalate — see the report status flow.

// ── Admin only: account actions and PII ──────────────────
router.get("/stats", requireAuth, requireAdmin, stats);
router.get("/users", requireAuth, requireAdmin, listUsers);
router.patch("/users/:id/ban", requireAuth, requireAdmin, setBanned);

// Role changes live in their own controller. requireAdmin already re-reads
// role from the database on every request, so a demotion applies to the
// target's next request rather than waiting for their JWT to expire.
router.patch("/users/:id/role", requireAuth, requireAdmin, setUserRole);
router.get(
  "/users/:id/role-history",
  requireAuth,
  requireAdmin,
  listRoleChanges,
);
router.get("/role-changes", requireAuth, requireAdmin, listAllRoleChanges);

// ── Moderator or admin: content moderation ───────────────
router.get("/posts", requireAuth, requireModerator, adminListPosts);
router.delete("/posts/:id", requireAuth, requireModerator, adminDeletePost);
router.get("/reports", requireAuth, requireModerator, listReports);
router.patch("/reports/:id", requireAuth, requireModerator, resolveReport);

// Messages a participant has hidden from their own view — "deleted messages"
// in the admin UI. Hiding never modifies the document, so the original text is
// returned. Listed BEFORE the /conversations route only for readability; the
// paths do not overlap.
router.get(
  "/messages/hidden",
  requireAuth,
  requireModerator,
  adminListHiddenMessages,
);

// Messages a SENDER withdrew. Retraction is irreversible and there is no
// restore here by design — this exists so a moderator can still read what
// was said when a complaint arrives after the fact. retractMessage refuses
// once a Report exists, so a row flagged BOTH retracted and reported means
// the report came second, and the thread will not contain the text.
router.get(
  "/messages/retracted",
  requireAuth,
  requireModerator,
  adminListRetractedMessages,
);

// Messages a MODERATOR took down — "removed by moderators" in the admin UI.
// Unlike hiding, removal modifies the document: the sender keeps a tombstone,
// the recipient's thread loses the message entirely. Reversible, and
// attributed to whoever did it. A message can be both hidden and removed;
// restoring does not un-hide it for a participant who had also hidden it.
router.get(
  "/messages/removed",
  requireAuth,
  requireModerator,
  adminListRemovedMessages,
);
router.post(
  "/messages/:id/remove",
  requireAuth,
  requireModerator,
  adminRemoveMessage,
);
router.post(
  "/messages/:id/restore",
  requireAuth,
  requireModerator,
  adminRestoreMessage,
);

// Full thread around a reported message, UNFILTERED by hiddenFor. A privileged
// read of a private conversation: the staff gate is the only check, and there
// is deliberately no participant check, because a moderator cannot judge one
// line without what surrounds it. This is the most sensitive thing a moderator
// can do, and the reason the role is worth auditing.
router.get(
  "/conversations/:id/messages",
  requireAuth,
  requireModerator,
  adminGetMessages,
);

export default router;
