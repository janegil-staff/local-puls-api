// local-pulse-api/src/models/Call.js

import mongoose from "mongoose";

const { Schema } = mongoose;

export const CALL_STATUS = {
  RINGING: "ringing",
  ACCEPTED: "accepted",
  CONNECTED: "connected",
  ENDED: "ended",
  DECLINED: "declined",
  MISSED: "missed",
  CANCELLED: "cancelled",
  FAILED: "failed",
};

export const CALL_END_REASON = {
  HANGUP: "hangup",
  DECLINED: "declined",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
  BUSY: "busy",
  DISCONNECTED: "disconnected",
  ICE_FAILED: "ice_failed",
  BLOCKED: "blocked",
  MODERATED: "moderated",
};

const TERMINAL_STATUSES = [
  CALL_STATUS.ENDED,
  CALL_STATUS.DECLINED,
  CALL_STATUS.MISSED,
  CALL_STATUS.CANCELLED,
  CALL_STATUS.FAILED,
];

const callSchema = new Schema(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    caller: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    callee: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    media: {
      type: String,
      enum: ["video", "audio"],
      default: "video",
    },
    status: {
      type: String,
      enum: Object.values(CALL_STATUS),
      default: CALL_STATUS.RINGING,
      index: true,
    },
    endReason: {
      type: String,
      enum: Object.values(CALL_END_REASON),
      default: null,
    },
    endedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    answeredAt: {
      type: Date,
      default: null,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    // Denormalised so call history queries never need to diff dates.
    durationSeconds: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Whether the media path ended up relayed through TURN. Useful signal
    // when debugging connectivity complaints from a specific network.
    usedRelay: {
      type: Boolean,
      default: false,
    },
    // Moderation surface: a call can be reported after the fact even though
    // the media itself is never stored.
    reported: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true },
);

// Fast lookup for "is this user already busy?" checks.
callSchema.index({ caller: 1, status: 1 });
callSchema.index({ callee: 1, status: 1 });
callSchema.index({ conversation: 1, createdAt: -1 });

callSchema.virtual("isActive").get(function isActive() {
  return !TERMINAL_STATUSES.includes(this.status);
});

callSchema.methods.participantIds = function participantIds() {
  return [String(this.caller), String(this.callee)];
};

callSchema.methods.otherParticipantId = function otherParticipantId(userId) {
  const id = String(userId);
  if (String(this.caller) === id) return String(this.callee);
  if (String(this.callee) === id) return String(this.caller);
  return null;
};

callSchema.methods.hasParticipant = function hasParticipant(userId) {
  return this.participantIds().includes(String(userId));
};

/**
 * Close out a call and stamp the duration in one place so every code path
 * (hangup, decline, timeout, socket disconnect) produces consistent records.
 */
callSchema.methods.finalize = function finalize({ status, reason, endedBy }) {
  if (TERMINAL_STATUSES.includes(this.status)) return this;

  this.status = status;
  this.endReason = reason || null;
  this.endedBy = endedBy || null;
  this.endedAt = new Date();

  if (this.answeredAt) {
    this.durationSeconds = Math.max(
      0,
      Math.round((this.endedAt.getTime() - this.answeredAt.getTime()) / 1000),
    );
  }

  return this;
};

callSchema.statics.findActiveForUser = function findActiveForUser(userId) {
  return this.findOne({
    status: { $nin: TERMINAL_STATUSES },
    $or: [{ caller: userId }, { callee: userId }],
  });
};

callSchema.set("toJSON", { virtuals: true });
callSchema.set("toObject", { virtuals: true });

const Call = mongoose.models.Call || mongoose.model("Call", callSchema);

export default Call;
