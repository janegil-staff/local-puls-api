// local-pulse-api/src/controllers/callController.js

import mongoose from "mongoose";
import Call from "../models/Call.js";
import Conversation from "../models/Conversation.js";
import { createIceServers } from "../services/turnService.js";

/**
 * REST surface for calling. Signaling itself runs over Socket.IO
 * (see src/sockets/callHandlers.js) — these endpoints cover credentials,
 * history and moderation.
 */

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * GET /api/calls/ice-servers
 *
 * Ephemeral TURN credentials. Fetch immediately before creating the peer
 * connection; they expire (default 1h) and must never be cached long-term.
 */
export const getIceServers = async (req, res, next) => {
  try {
    const config = createIceServers(String(req.user._id));
    return res.json(config);
  } catch (error) {
    return next(error);
  }
};

/**
 * GET /api/calls/conversation/:conversationId?limit=30&before=<ISO date>
 *
 * Call log for a single thread, newest first. Used to render call events
 * inline in the chat timeline.
 */
export const getCallsForConversation = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const { before } = req.query;

    if (!isValidId(conversationId)) {
      return res.status(400).json({ message: "Invalid conversationId." });
    }

    const conversation = await Conversation.findById(conversationId).lean();
    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found." });
    }

    const participants = (conversation.participants || []).map(String);
    if (!participants.includes(String(req.user._id))) {
      return res.status(403).json({ message: "Not a participant." });
    }

    const query = { conversation: conversationId };
    if (before) {
      const beforeDate = new Date(before);
      if (!Number.isNaN(beforeDate.getTime())) {
        query.createdAt = { $lt: beforeDate };
      }
    }

    const calls = await Call.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("caller", "displayName avatarUrl")
      .populate("callee", "displayName avatarUrl")
      .lean();

    return res.json({ calls, hasMore: calls.length === limit });
  } catch (error) {
    return next(error);
  }
};

/**
 * GET /api/calls/recent?limit=30
 *
 * Cross-conversation call history for the signed-in user.
 */
export const getRecentCalls = async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const userId = req.user._id;

    const calls = await Call.find({
      $or: [{ caller: userId }, { callee: userId }],
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("caller", "displayName avatarUrl")
      .populate("callee", "displayName avatarUrl")
      .lean();

    const withDirection = calls.map((call) => ({
      ...call,
      direction:
        String(call.caller?._id ?? call.caller) === String(userId)
          ? "outgoing"
          : "incoming",
    }));

    return res.json({ calls: withDirection, hasMore: calls.length === limit });
  } catch (error) {
    return next(error);
  }
};

/**
 * POST /api/calls/:callId/report
 * body: { reason, details }
 *
 * Compliance surface. Call media is never recorded or stored, so a report
 * flags the call record and the counterparty for the moderation queue —
 * moderators act on the reporter's account of it plus the user's history.
 */
export const reportCall = async (req, res, next) => {
  try {
    const { callId } = req.params;
    const { reason, details = "" } = req.body || {};

    if (!isValidId(callId)) {
      return res.status(400).json({ message: "Invalid callId." });
    }
    if (!reason) {
      return res.status(400).json({ message: "A reason is required." });
    }

    const call = await Call.findById(callId);
    if (!call) return res.status(404).json({ message: "Call not found." });

    const reporterId = String(req.user._id);
    if (!call.hasParticipant(reporterId)) {
      return res.status(403).json({ message: "Not a participant." });
    }

    call.reported = true;
    await call.save();

    // TODO(moderation): create a Report document through the same service the
    // message-report flow uses so this lands in the existing admin queue with
    // targetType: 'call'. Keeping one queue matters for App Store review.
    //
    //   await createReport({
    //     reporter: reporterId,
    //     targetType: 'call',
    //     targetId: call._id,
    //     reportedUser: call.otherParticipantId(reporterId),
    //     reason,
    //     details,
    //   });

    return res.status(201).json({ ok: true, callId: String(call._id) });
  } catch (error) {
    return next(error);
  }
};

export default {
  getIceServers,
  getCallsForConversation,
  getRecentCalls,
  reportCall,
};
