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

    // ── THREE WAYS A MESSAGE STOPS BEING VISIBLE ──────────────────────
    //
    // None of them modifies or deletes the document. The text always stays,
    // which is what keeps reports actionable, moderation honest, and the
    // moderator's restore possible.

    // 1. hiddenFor — "delete for me". Per-user, one-sided, irreversible, no
    //    author. Used on the OTHER party's messages. They keep their copy.
    hiddenFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    // 2. retractedAt — "delete for everyone". The SENDER withdrawing their own
    //    message; it disappears for both parties with no tombstone, at any
    //    time, with no window.
    //
    //    Be aware of what that buys and costs. It covers wrong-words and
    //    wrong-chat completely. It also means a recipient can be sent
    //    something and have it vanish before they can report it — reporting
    //    requires seeing the message. The stored text and this timestamp are
    //    the only remaining trace, visible to admins via toAdmin(), and
    //    reportMessage() refuses to retract anything already reported so an
    //    open complaint cannot have its subject erased underneath it.
    retractedAt: { type: Date },

    // 3. removedByAdmin — a moderator decision. Affects both parties, has an
    //    author, and is reversible. ASYMMETRIC: the sender gets a tombstone
    //    from toClient(); the recipient is filtered out at the query, because
    //    a placeholder would keep pointing at content they were better off not
    //    receiving. `at` is the presence test.
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

// viewerId decides what a REMOVED message looks like. Retracted messages never
// reach here — they are filtered out for everyone, sender included.
//
// The text is blanked in the response, never in the document: a moderator
// restoring a message must get the message back, not an empty bubble.
messageSchema.methods.toClient = function toClient(viewerId) {
  const s =
    this.sender && this.sender.toPublic ? this.sender.toPublic() : this.sender;
  const removed = Boolean(this.removedByAdmin && this.removedByAdmin.at);

  if (removed) {
    // Recipients are filtered out at the query. If one arrives here anyway,
    // fail closed: no text, no image.
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

// Moderation serializer. Returns the ORIGINAL text no matter who hid it, who
// retracted it, or whether a moderator removed it — a report is unactionable
// without the record as sent, and restore needs it to still be there.
//
// Separate from toClient() rather than a flag on it, so a participant read
// path can never serve hidden, retracted or removed content by passing the
// wrong argument.
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
    retracted: Boolean(this.retractedAt),
    retractedAt: this.retractedAt || null,
    removed: Boolean(r.at),
    removedAt: r.at || null,
    removedBy: r.by ? String(r.by) : null,
    removedReason: r.reason || "",
    createdAt: this.createdAt,
  };
};

export default mongoose.model("Message", messageSchema);
