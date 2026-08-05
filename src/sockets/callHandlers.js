// local-pulse-api/src/sockets/callHandlers.js

import mongoose from "mongoose";
import Call, { CALL_STATUS, CALL_END_REASON } from "../models/Call.js";
import Conversation from "../models/Conversation.js";
import registry from "../services/callRegistry.js";
import { createIceServers } from "../services/turnService.js";

/**
 * WebRTC signaling for 1:1 calls.
 *
 * WIRING (in your existing socket bootstrap, alongside the chat handlers):
 *
 *   import registerCallHandlers from './sockets/callHandlers.js';
 *   io.on('connection', (socket) => {
 *     registerChatHandlers(io, socket);
 *     registerCallHandlers(io, socket);
 *   });
 *
 * ASSUMPTIONS — adjust to match the existing socket layer:
 *   - `socket.user` is populated by the auth middleware and has `_id`.
 *   - Every authenticated socket joins a personal room `user:<userId>`.
 *     If yours is named differently, change USER_ROOM below and nothing else.
 *   - `Conversation` has a `participants` array of user ObjectIds.
 */

const USER_ROOM = (userId) => `user:${userId}`;

const ERRORS = {
  UNAUTHORIZED: "unauthorized",
  NOT_FOUND: "not_found",
  NOT_ALLOWED: "not_allowed",
  NOT_ONE_TO_ONE: "not_one_to_one",
  BUSY: "busy",
  ALREADY_IN_CALL: "already_in_call",
  OFFLINE: "offline",
  INVALID: "invalid",
};

function fail(ack, code, message) {
  if (typeof ack === "function") ack({ ok: false, error: code, message });
  return null;
}

function ok(ack, payload = {}) {
  if (typeof ack === "function") ack({ ok: true, ...payload });
  return payload;
}

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

async function isUserOnline(io, userId) {
  const sockets = await io.in(USER_ROOM(userId)).fetchSockets();
  return sockets.length > 0;
}

/**
 * Shape a Call document for the wire. Never leaks anything the other party
 * shouldn't see.
 */
function serializeCall(call) {
  return {
    callId: String(call._id),
    conversationId: String(call.conversation),
    callerId: String(call.caller),
    calleeId: String(call.callee),
    media: call.media,
    status: call.status,
    startedAt: call.startedAt,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    durationSeconds: call.durationSeconds,
    endReason: call.endReason,
  };
}

export default function registerCallHandlers(io, socket) {
  const userId = String(socket.user?._id || socket.userId || "");
  if (!userId) return;

  /**
   * Terminate a call from any code path and notify both sides exactly once.
   */
  async function terminate({ callId, status, reason, endedBy, notify = true }) {
    const entry = registry.get(callId);
    const call = await Call.findById(callId);

    if (!call) {
      registry.release(callId);
      return null;
    }

    if (!call.isActive) {
      registry.release(callId);
      return call;
    }

    call.finalize({ status, reason, endedBy });
    await call.save();

    registry.release(callId);

    if (notify) {
      const payload = serializeCall(call);
      const targets = entry
        ? [entry.callerId, entry.calleeId]
        : call.participantIds();

      targets.forEach((id) => {
        io.to(USER_ROOM(id)).emit("call:ended", payload);
      });
    }

    return call;
  }

  // ---------------------------------------------------------------------
  // Caller starts a call
  // ---------------------------------------------------------------------
  socket.on("call:invite", async (payload = {}, ack) => {
    const { conversationId, media = "video" } = payload;

    if (!isValidId(conversationId)) {
      return fail(ack, ERRORS.INVALID, "Missing or malformed conversationId.");
    }
    if (!["video", "audio"].includes(media)) {
      return fail(ack, ERRORS.INVALID, 'media must be "video" or "audio".');
    }

    const conversation = await Conversation.findById(conversationId).lean();
    if (!conversation) {
      return fail(ack, ERRORS.NOT_FOUND, "Conversation not found.");
    }

    const participants = (conversation.participants || []).map(String);

    if (!participants.includes(userId)) {
      return fail(ack, ERRORS.NOT_ALLOWED, "Not a participant.");
    }

    // Calling is deliberately limited to established 1:1 threads. Group calls
    // would need an SFU, and open-to-anyone-nearby video is a moderation
    // problem we are not signing up for.
    if (participants.length !== 2) {
      return fail(
        ack,
        ERRORS.NOT_ONE_TO_ONE,
        "Calls are only available in one-to-one conversations.",
      );
    }

    const calleeId = participants.find((id) => id !== userId);
    if (!calleeId) {
      return fail(
        ack,
        ERRORS.INVALID,
        "Could not resolve the other participant.",
      );
    }

    // TODO(moderation): also reject when either side has blocked the other, or
    // when the conversation is under moderation hold. Wire to the same helper
    // the message send path uses.

    if (registry.isUserBusy(userId)) {
      return fail(ack, ERRORS.ALREADY_IN_CALL, "You are already in a call.");
    }
    if (registry.isUserBusy(calleeId)) {
      return fail(
        ack,
        ERRORS.BUSY,
        "The other participant is already in a call.",
      );
    }

    const online = await isUserOnline(io, calleeId);

    const call = await Call.create({
      conversation: conversationId,
      caller: userId,
      callee: calleeId,
      media,
      status: CALL_STATUS.RINGING,
      startedAt: new Date(),
    });

    const callId = String(call._id);
    registry.register({ callId, callerId: userId, calleeId });

    registry.startRingTimeout(callId, async (timedOutCallId) => {
      await terminate({
        callId: timedOutCallId,
        status: CALL_STATUS.MISSED,
        reason: CALL_END_REASON.TIMEOUT,
      });
    });

    const wire = serializeCall(call);

    // Ring every device the callee is signed in on.
    io.to(USER_ROOM(calleeId)).emit("call:incoming", wire);

    // TODO(push): if `online` is false, or in addition to the socket emit,
    // send a VoIP push (APNs PushKit + CallKit on iOS, high-priority FCM data
    // message with a full-screen intent on Android) so the device rings when
    // the app is backgrounded or killed.

    return ok(ack, {
      call: wire,
      calleeOnline: online,
      ...createIceServers(userId),
    });
  });

  // ---------------------------------------------------------------------
  // Callee accepts — this only unlocks negotiation, the caller sends the offer
  // ---------------------------------------------------------------------
  socket.on("call:accept", async (payload = {}, ack) => {
    const { callId } = payload;
    if (!isValidId(callId)) return fail(ack, ERRORS.INVALID, "Missing callId.");

    const call = await Call.findById(callId);
    if (!call) return fail(ack, ERRORS.NOT_FOUND, "Call not found.");
    if (String(call.callee) !== userId) {
      return fail(ack, ERRORS.NOT_ALLOWED, "Only the callee can accept.");
    }
    if (call.status !== CALL_STATUS.RINGING) {
      return fail(ack, ERRORS.INVALID, `Call is ${call.status}.`);
    }

    call.status = CALL_STATUS.ACCEPTED;
    await call.save();

    registry.clearRingTimeout(callId);
    registry.startConnectTimeout(callId, async (stuckCallId) => {
      await terminate({
        callId: stuckCallId,
        status: CALL_STATUS.FAILED,
        reason: CALL_END_REASON.ICE_FAILED,
      });
    });

    const wire = serializeCall(call);

    // Tell the caller to start negotiation.
    io.to(USER_ROOM(String(call.caller))).emit("call:accepted", wire);

    // Stop other devices of the callee from continuing to ring.
    socket
      .to(USER_ROOM(userId))
      .emit("call:handled", { callId: String(callId) });

    return ok(ack, { call: wire, ...createIceServers(userId) });
  });

  // ---------------------------------------------------------------------
  // SDP relay
  // ---------------------------------------------------------------------
  socket.on("call:offer", async (payload = {}, ack) => {
    const { callId, sdp } = payload;
    if (!isValidId(callId) || !sdp) {
      return fail(ack, ERRORS.INVALID, "Missing callId or sdp.");
    }

    const call = await Call.findById(callId).lean();
    if (!call) return fail(ack, ERRORS.NOT_FOUND, "Call not found.");
    if (String(call.caller) !== userId) {
      return fail(ack, ERRORS.NOT_ALLOWED, "Only the caller sends the offer.");
    }

    io.to(USER_ROOM(String(call.callee))).emit("call:offer", {
      callId: String(callId),
      sdp,
    });

    return ok(ack);
  });

  socket.on("call:answer", async (payload = {}, ack) => {
    const { callId, sdp } = payload;
    if (!isValidId(callId) || !sdp) {
      return fail(ack, ERRORS.INVALID, "Missing callId or sdp.");
    }

    const call = await Call.findById(callId).lean();
    if (!call) return fail(ack, ERRORS.NOT_FOUND, "Call not found.");
    if (String(call.callee) !== userId) {
      return fail(ack, ERRORS.NOT_ALLOWED, "Only the callee sends the answer.");
    }

    io.to(USER_ROOM(String(call.caller))).emit("call:answer", {
      callId: String(callId),
      sdp,
    });

    return ok(ack);
  });

  // ---------------------------------------------------------------------
  // Trickle ICE
  // ---------------------------------------------------------------------
  socket.on("call:ice", async (payload = {}, ack) => {
    const { callId, candidate } = payload;
    if (!isValidId(callId) || !candidate) {
      return fail(ack, ERRORS.INVALID, "Missing callId or candidate.");
    }

    const entry = registry.get(callId);
    let targetId = null;

    if (entry) {
      targetId = entry.callerId === userId ? entry.calleeId : entry.callerId;
      if (entry.callerId !== userId && entry.calleeId !== userId)
        targetId = null;
    } else {
      const call = await Call.findById(callId).lean();
      if (!call) return fail(ack, ERRORS.NOT_FOUND, "Call not found.");
      if (String(call.caller) === userId) targetId = String(call.callee);
      else if (String(call.callee) === userId) targetId = String(call.caller);
    }

    if (!targetId) return fail(ack, ERRORS.NOT_ALLOWED, "Not a participant.");

    io.to(USER_ROOM(targetId)).emit("call:ice", {
      callId: String(callId),
      candidate,
    });

    return ok(ack);
  });

  // ---------------------------------------------------------------------
  // Media actually flowing
  // ---------------------------------------------------------------------
  socket.on("call:connected", async (payload = {}, ack) => {
    const { callId, usedRelay = false } = payload;
    if (!isValidId(callId)) return fail(ack, ERRORS.INVALID, "Missing callId.");

    const call = await Call.findById(callId);
    if (!call) return fail(ack, ERRORS.NOT_FOUND, "Call not found.");
    if (!call.hasParticipant(userId)) {
      return fail(ack, ERRORS.NOT_ALLOWED, "Not a participant.");
    }

    registry.clearConnectTimeout(callId);

    // Either side may report first; only the first report stamps the clock.
    if (call.status !== CALL_STATUS.CONNECTED) {
      call.status = CALL_STATUS.CONNECTED;
      call.answeredAt = call.answeredAt || new Date();
      call.usedRelay = Boolean(usedRelay);
      await call.save();

      const wire = serializeCall(call);
      call.participantIds().forEach((id) => {
        io.to(USER_ROOM(id)).emit("call:connected", wire);
      });
    }

    return ok(ack, { call: serializeCall(call) });
  });

  // ---------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------
  socket.on("call:decline", async (payload = {}, ack) => {
    const { callId } = payload;
    if (!isValidId(callId)) return fail(ack, ERRORS.INVALID, "Missing callId.");

    const call = await Call.findById(callId).lean();
    if (!call) return fail(ack, ERRORS.NOT_FOUND, "Call not found.");
    if (String(call.callee) !== userId) {
      return fail(ack, ERRORS.NOT_ALLOWED, "Only the callee can decline.");
    }

    await terminate({
      callId,
      status: CALL_STATUS.DECLINED,
      reason: CALL_END_REASON.DECLINED,
      endedBy: userId,
    });

    return ok(ack);
  });

  socket.on("call:cancel", async (payload = {}, ack) => {
    const { callId } = payload;
    if (!isValidId(callId)) return fail(ack, ERRORS.INVALID, "Missing callId.");

    const call = await Call.findById(callId).lean();
    if (!call) return fail(ack, ERRORS.NOT_FOUND, "Call not found.");
    if (String(call.caller) !== userId) {
      return fail(ack, ERRORS.NOT_ALLOWED, "Only the caller can cancel.");
    }

    await terminate({
      callId,
      status: CALL_STATUS.CANCELLED,
      reason: CALL_END_REASON.CANCELLED,
      endedBy: userId,
    });

    return ok(ack);
  });

  socket.on("call:end", async (payload = {}, ack) => {
    const { callId } = payload;
    if (!isValidId(callId)) return fail(ack, ERRORS.INVALID, "Missing callId.");

    const call = await Call.findById(callId).lean();
    if (!call) return fail(ack, ERRORS.NOT_FOUND, "Call not found.");

    const participants = [String(call.caller), String(call.callee)];
    if (!participants.includes(userId)) {
      return fail(ack, ERRORS.NOT_ALLOWED, "Not a participant.");
    }

    await terminate({
      callId,
      status: CALL_STATUS.ENDED,
      reason: CALL_END_REASON.HANGUP,
      endedBy: userId,
    });

    return ok(ack);
  });

  // ---------------------------------------------------------------------
  // Connection loss
  // ---------------------------------------------------------------------
  socket.on("disconnect", async () => {
    const callId = registry.getCallIdForUser(userId);
    if (!callId) return;

    // Give the client a short grace period to reconnect (app backgrounded,
    // network handover from wifi to LTE) before killing the call.
    setTimeout(async () => {
      const stillOnline = await isUserOnline(io, userId);
      if (stillOnline) return;
      if (registry.getCallIdForUser(userId) !== callId) return;

      await terminate({
        callId,
        status: CALL_STATUS.ENDED,
        reason: CALL_END_REASON.DISCONNECTED,
        endedBy: userId,
      });
    }, 8000);
  });
}
