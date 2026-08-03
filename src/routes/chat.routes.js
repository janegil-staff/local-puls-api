// localpulse/server/src/routes/chat.routes.js
import { Router } from "express";
import {
  listConversations,
  listRequests,
  openConversation,
  acceptConversation,
  getMessages,
  sendMessage,
  hideMessage,
  reportMessage,
  chatUnreadCount,
  markRead,
} from "../controllers/chatController.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

router.get("/conversations", requireAuth, listConversations);
router.get("/requests", requireAuth, listRequests);
router.get("/unread-count", requireAuth, chatUnreadCount);

router.post("/conversations/:userId", requireAuth, openConversation);
router.post("/conversations/:id/accept", requireAuth, acceptConversation);

router.get("/conversations/:id/messages", requireAuth, getMessages);
router.post(
  "/conversations/:id/messages",
  requireAuth,
  validate({ body: { text: { type: "string", min: 1, max: 2000 } } }),
  sendMessage,
);

router.post("/conversations/:id/read", requireAuth, markRead);

// Per-message actions, addressed by MESSAGE id rather than nested under
// /conversations/:id — the client has the message id in hand, and each
// controller resolves the conversation itself for the membership check, so
// passing it twice would only create a chance to disagree.
//
//   hide / unhide  the OTHER party's message, my view only. Unhide has no time
//                  limit: hiding never affected them, so restoring it cannot
//                  surprise anyone.
//   retract        MY message, gone for both. Blocked once the message is
//                  reported. IRREVERSIBLE — there is no unretract, by
//                  decision: the sender is told so in the confirm dialog, and
//                  an un-retract would let someone remove and restore a
//                  message around a moderator's review of it.
//   report         to the moderation queue.
//
// No validate(): none of these has a body except report, whose `reason` is an
// enum this validate() DSL cannot express — reportMessage checks it against
// REPORT_REASONS and returns 400 rather than letting an unknown value reach
// Mongoose as a 500.
router.post("/messages/:id/hide", requireAuth, hideMessage);

// Re-enable once retractMessage exists in chatController.js. The web client
// already calls this path, so it 404s until then — a working 404 beats a dead
// server.
// router.post("/messages/:id/retract", requireAuth, retractMessage);

router.post("/messages/:id/report", requireAuth, reportMessage);

export default router;
