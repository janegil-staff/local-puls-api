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
  retractMessage,
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
// hide    = the OTHER party's message, gone for me only, irreversible
// retract = MY message, gone for both, no time limit, blocked once reported
// report  = to the moderation queue
//
// No validate(): hide and retract have no body, and report's `reason` is an
// enum, which this validate() DSL cannot express — reportMessage checks it
// against REPORT_REASONS and returns 400 rather than letting an unknown value
// reach Mongoose as a 500.
router.post("/messages/:id/hide", requireAuth, hideMessage);
router.post("/messages/:id/retract", requireAuth, retractMessage);
router.post("/messages/:id/report", requireAuth, reportMessage);

export default router;
