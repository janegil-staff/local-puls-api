// localpulse/server/src/routes/callRoutes.js

import express from "express";
import {
  getIceServers,
  getCallsForConversation,
  getRecentCalls,
  reportCall,
} from "../controllers/callController.js";
import { requireAuth } from "../middleware/auth.js";

/**
 * Mount in the app bootstrap:
 *   import callRoutes from './routes/callRoutes.js';
 *   app.use('/api/calls', callRoutes);
 *
 * Every route here is authenticated — there is no anonymous surface for
 * calling. `requireAuth` populates `req.user` (full document) and
 * `req.userId` (string), both of which callController relies on.
 */

const router = express.Router();

router.use(requireAuth);

// Ephemeral TURN credentials. Fetched immediately before each peer connection
// is created — they expire, so nothing here is cacheable long-term.
router.get("/ice-servers", getIceServers);

// Call log across all of the signed-in user's conversations.
router.get("/recent", getRecentCalls);

// Call log for a single thread, for rendering call events inline in chat.
router.get("/conversation/:conversationId", getCallsForConversation);

// Moderation surface. Call media is never recorded, so this report is the
// only signal moderators get about what happened.
router.post("/:callId/report", reportCall);

export default router;
