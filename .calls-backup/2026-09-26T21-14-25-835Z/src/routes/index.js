// localpulse/server/src/routes/index.js
//
// Mount order matters here. Two of these are mounted at "/" and will happily
// swallow anything below them if they ever gain a route with a leading param,
// so they sit LAST — see the note above them.

import { Router } from "express";

import authRoutes from "./auth.routes.js";
import profileRoutes from "./profile.routes.js";
import discoveryRoutes from "./discovery.routes.js";
import postRoutes from "./post.routes.js";
import userRoutes from "./user.routes.js";
import chatRoutes from "./chat.routes.js";
import notificationRoutes, { pushRouter } from "./notification.routes.js";
import adminRoutes from "./admin.routes.js";
import miscRoutes from "./misc.routes.js";
import seedRoutes from "./seed.routes.js";
import callRoutes from "./call.routes.js";

const router = Router();

router.use("/auth", authRoutes);

// /me before /users, or a route like /users/:username would need to be
// careful not to catch it. They are separate mounts here, so this is only a
// readability convention — but keep it.
router.use("/me", profileRoutes);
router.use("/users", userRoutes);

router.use("/posts", postRoutes);
router.use("/chat", chatRoutes);
router.use("/notifications", notificationRoutes);
router.use("/push", pushRouter);
router.use("/admin", adminRoutes);

if (process.env.ALLOW_SEEDING === "true") {
  router.use("/admin/seed", seedRoutes);
}
// Mounted at "/" — anything below these is only reachable if neither of them
// matches first. Keep them at the bottom, and keep their routes explicitly
// named: the day one of them gains a "/:id" route, every mount above it that
// happens to be one segment long stops working, and the failure looks like a
// routing mystery rather than an ordering mistake.
router.use("/", discoveryRoutes); // /discovery, /swipe, /matches
router.use("/", miscRoutes); // /geocode, /location, /upload, /blocks, etc.

export default router;
