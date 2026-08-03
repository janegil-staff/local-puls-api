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

// Per-user hide — "delete for me". Addressed by MESSAGE id, not conversation
// id, so it sits on its own /messages path rather than nested under
// /conversations/:id: the client has the message id in hand and would
// otherwise have to pass the conversation twice. hideMessage() does the
// membership check itself by looking up the message's conversation.
//
// No validate() — there is no body. The id is validated as an ObjectId in the
// controller, which also distinguishes 404 (no such message) from 403 (not a
// participant).
router.post("/messages/:id/hide", requireAuth, hideMessage);

export default router;
