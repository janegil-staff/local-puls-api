// localpulse/server/src/lib/pendingGuard.js
//
// Enforces the message-request rules on a pending conversation.
//
// This is the check that stops the app being an unsolicited-DM channel: a
// stranger gets ONE message to introduce themselves, and nothing more until
// the recipient accepts. Without it, "message requests" is a label on a
// screen rather than a protection — which is what the two consecutive 201s
// in the logs showed.
//
// Lives in its own module so both the REST path and the socket path can call
// it, and so it can be unit tested without a database.
//
//   import { checkPendingRules } from "../lib/pendingGuard.js";
//
//   const blocked = await checkPendingRules({ convo, senderId, Message });
//   if (blocked) return { error: blocked.error, status: blocked.status };

/**
 * Returns null when the message may be sent, or { error, status } when it
 * may not. `error` is a TRANSLATION KEY, not a sentence — chatPendingLimit
 * and chatPendingRecipient already exist in all 12 locale files, and
 * chatStore.send() maps them to the alert text.
 *
 * @param {object}   convo      the Conversation document
 * @param {string}   senderId   the authenticated user's id
 * @param {Model}    Message    the Message model, injected so this module
 *                              does not import it and create a cycle
 * @param {number}   limit      messages the initiator may send while pending
 */
export async function checkPendingRules({
  convo,
  senderId,
  Message,
  limit = 1,
}) {
  // Accepted conversations have no restrictions.
  if (!convo || convo.status !== "pending") return null;

  const isInitiator = String(convo.initiator) === String(senderId);

  if (isInitiator) {
    // Counted from the messages themselves rather than a counter on the
    // conversation. A counter can drift — a failed write, a retry, a
    // migration — and drifting the wrong way silently reopens the hole.
    const alreadySent = await Message.countDocuments({
      conversation: convo._id,
      sender: senderId,
    });

    if (alreadySent >= limit) {
      return { error: "chatPendingLimit", status: 403 };
    }

    return null;
  }

  // The recipient. Replying to a pending request is NOT implicit acceptance
  // here: acceptance is an explicit action, so that "I replied" and "I
  // accepted this person" stay distinguishable — which matters for blocking
  // and for reporting.
  //
  // If you would rather a reply auto-accept, do it at the call site by
  // flipping convo.status before this runs. Do not simply drop this branch:
  // that leaves the thread deadlocked, with the initiator out of messages
  // and the recipient never having accepted.
  return { error: "chatPendingRecipient", status: 403 };
}

/**
 * Whether this user may currently send in this conversation. Same rules,
 * shaped for the client so the input can be disabled BEFORE the user types
 * a message and has it rejected.
 *
 * Worth returning from GET /conversations/:id/messages alongside status.
 */
export async function pendingState({ convo, userId, Message, limit = 1 }) {
  if (!convo || convo.status !== "pending") {
    return { canSend: true, reason: null, remaining: null };
  }

  const isInitiator = String(convo.initiator) === String(userId);

  if (!isInitiator) {
    return { canSend: false, reason: "chatPendingRecipient", remaining: 0 };
  }

  const alreadySent = await Message.countDocuments({
    conversation: convo._id,
    sender: userId,
  });

  const remaining = Math.max(0, limit - alreadySent);

  return {
    canSend: remaining > 0,
    reason: remaining > 0 ? null : "chatPendingLimit",
    remaining,
  };
}
