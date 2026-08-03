// localpulse/server/src/models/Message.js
import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Required only for text messages. An image message carries an imageUrl
    // and no text — hence the function form rather than `true`.
    text: {
      type: String,
      trim: true,
      maxlength: 2000,
      required: function requiredWithoutImage() {
        return !this.imageUrl;
      },
    },
    // A URL returned by the /upload route. Absent on text messages.
    imageUrl: { type: String },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    // Per-user soft hide — "delete for me", NOT a retraction. The message stays
    // in the collection and stays visible to every participant whose id is
    // absent from this array. Nothing is removed and the text is never blanked:
    // a report on a message that no longer exists is unactionable.
    //
    // Every participant read MUST filter on this (`hiddenFor: { $ne: me }`).
    // Admin reads must NOT.
    hiddenFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    // Moderator removal. Distinct from hiddenFor in three ways: it affects
    // BOTH parties, it has an author, and it is reversible.
    //
    // Asymmetric by design. The SENDER sees a tombstone — they should learn
    // their message was removed, or removal teaches nothing and deters
    // nothing. The RECIPIENT sees nothing at all: the message is filtered out
    // of their thread entirely, because a placeholder would keep pointing at
    // content they were better off not receiving.
    //
    // `at` is the presence test — queries use { 'removedByAdmin.at': ... }
    // rather than checking the subdocument, which always exists once the path
    // is declared.
    removedByAdmin: {
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      at: { type: Date },
      reason: { type: String, maxlength: 500 },
    },
  },
  { timestamps: true },
);

messageSchema.index({ conversation: 1, createdAt: 1 });
// Supports the hiddenFor filter on the thread read, which is the hot path.
messageSchema.index({ conversation: 1, hiddenFor: 1 });

// viewerId decides what a removed message looks like. Pass it on every
// participant-facing read; omit it only where the message cannot be removed
// yet, as in the echo of a message just created.
//
// The text is BLANKED here rather than at the database — the document keeps
// the original, because a moderator restoring a message must get the message
// back and not an empty bubble.
messageSchema.methods.toClient = function toClient(viewerId) {
  const s =
    this.sender && this.sender.toPublic ? this.sender.toPublic() : this.sender;
  const removed = Boolean(this.removedByAdmin && this.removedByAdmin.at);

  if (removed) {
    // Recipients never reach this — they are filtered out at the query. If one
    // does, fail closed: no text, no image.
    return {
      id: this._id,
      conversationId: this.conversation,
      sender: s,
      removed: true,
      removedAt: this.removedByAdmin.at,
      createdAt: this.createdAt,
    };
  }

  return {
    id: this._id,
    conversationId: this.conversation,
    sender: s,
    text: this.text,
    // Omit the key rather than sending null, so the client can check
    // `if (msg.imageUrl)` without a null guard.
    ...(this.imageUrl ? { imageUrl: this.imageUrl } : {}),
    createdAt: this.createdAt,
  };
};

// Moderation serializer. Returns the ORIGINAL text regardless of who hid it or
// whether it was removed — a moderator reviewing a report needs the record as
// sent, and restoring requires it to still be there.
//
// Separate from toClient() rather than a flag on it so a participant read path
// can never serve hidden or removed content by passing the wrong argument.
messageSchema.methods.toAdmin = function toAdmin() {
  const s =
    this.sender && this.sender.toPublic ? this.sender.toPublic() : this.sender;
  const r = this.removedByAdmin || {};

  return {
    id: this._id,
    conversationId: this.conversation,
    sender: s,
    text: this.text,
    ...(this.imageUrl ? { imageUrl: this.imageUrl } : {}),
    hiddenFor: (this.hiddenFor || []).map(String),
    hiddenCount: (this.hiddenFor || []).length,
    removed: Boolean(r.at),
    removedAt: r.at || null,
    removedBy: r.by ? String(r.by) : null,
    removedReason: r.reason || "",
    createdAt: this.createdAt,
  };
};

export default mongoose.model("Message", messageSchema);
