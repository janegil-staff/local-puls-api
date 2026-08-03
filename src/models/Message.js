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
    // in the collection, stays visible to every participant whose id is absent
    // from this array, and stays intact for moderation.
    //
    // Nothing is ever removed and the text is never blanked, deliberately: a
    // report on a message that no longer exists is unactionable, and in an app
    // where strangers message strangers, a real unsend would let someone send
    // abuse and erase it before the recipient could report it.
    //
    // Every read path that serves a participant MUST filter on this
    // (`hiddenFor: { $ne: me }`) — the thread, the unread count, and the inbox
    // preview. Admin read paths must NOT.
    hiddenFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true },
);

messageSchema.index({ conversation: 1, createdAt: 1 });
// Supports the hiddenFor filter on the thread read, which is the hot path.
messageSchema.index({ conversation: 1, hiddenFor: 1 });

messageSchema.methods.toClient = function toClient() {
  const s =
    this.sender && this.sender.toPublic ? this.sender.toPublic() : this.sender;
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

// Moderation serializer. Returns the ORIGINAL text regardless of who has
// hidden the message, plus who hid it — a moderator reviewing a report needs
// the record as sent, and needs to know a participant has hidden it from their
// own view (which is not evidence of anything, but is context).
//
// Separate from toClient() rather than a flag on it so that a participant read
// path can never accidentally serve hidden content by passing the wrong
// argument.
messageSchema.methods.toAdmin = function toAdmin() {
  const s =
    this.sender && this.sender.toPublic ? this.sender.toPublic() : this.sender;
  return {
    id: this._id,
    conversationId: this.conversation,
    sender: s,
    text: this.text,
    ...(this.imageUrl ? { imageUrl: this.imageUrl } : {}),
    hiddenFor: (this.hiddenFor || []).map(String),
    hiddenCount: (this.hiddenFor || []).length,
    createdAt: this.createdAt,
  };
};

export default mongoose.model("Message", messageSchema);
