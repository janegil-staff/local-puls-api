// localpulse/server/src/routes/seed.routes.js
import { Router } from "express";
import {
  uploadSeedAssets,
  seedDemoData,
  seedComments,
  removeSeedAssets,
  unseedComments,
  removeData,
  up,
  down,
  getSeedJob,
  listSeedJobs,
  cancelSeedJob,
} from "../controllers/adminSeedController.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();

router.use(requireAuth, requireAdmin);

// ── Single steps (synchronous) ──────────────────────────────────────────
router.post("/insert/assets", uploadSeedAssets);
router.post("/insert/data", seedDemoData);
router.post("/insert/comments", seedComments);
router.post("/remove/assets", removeSeedAssets);
router.post("/remove/comments", unseedComments);
router.post("/remove/data", removeData);

// ── Full runs (background jobs — return 202 { jobId }) ──────────────────
router.post("/up", up);
router.post("/down", down);

// ── Job status ──────────────────────────────────────────────────────────
// Declared before /jobs/:id so the literal path is not swallowed by the param.
router.get("/jobs", listSeedJobs);
router.get("/jobs/:id", getSeedJob);
router.post("/jobs/:id/cancel", cancelSeedJob);

export default router;
