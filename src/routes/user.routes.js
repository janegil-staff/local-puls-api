// localpulse/server/src/routes/user.routes.js
import { Router } from "express";
import {
  getProfile,
  follow,
  unfollow,
  listFollowers,
  listFollowing,
} from "../controllers/userController.js";

import {
  reportUser,
  blockUser,
  unblockUser,
  listBlocked,
} from "../controllers/moderationController.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";

const router = Router();

router.get("/:username", optionalAuth, getProfile);
router.post("/:id/follow", requireAuth, follow);
router.delete("/:id/follow", requireAuth, unfollow);

// User-facing moderation
router.post("/:userId/report", requireAuth, reportUser);
router.post("/:userId/block", requireAuth, blockUser);
router.delete("/:userId/block", requireAuth, unblockUser);

router.get("/:id/followers", requireAuth, listFollowers);
router.get("/:id/following", requireAuth, listFollowing);

export default router;
