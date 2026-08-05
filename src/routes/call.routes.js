// local-pulse-api/src/routes/callRoutes.js

import express from "express";
import {
  getIceServers,
  getCallsForConversation,
  getRecentCalls,
  reportCall,
} from "../controllers/callController.js";
import { protect } from "../middleware/authMiddleware.js";

/**
 * Mount in your app bootstrap:
 *   import callRoutes from './routes/callRoutes.js';
 *   app.use('/api/calls', callRoutes);
 *
 * NOTE: adjust the `protect` import to match the existing auth middleware
 * export name in local-pulse-api.
 */

const router = express.Router();

router.use(protect);

router.get("/ice-servers", getIceServers);
router.get("/recent", getRecentCalls);
router.get("/conversation/:conversationId", getCallsForConversation);
router.post("/:callId/report", reportCall);

export default router;
