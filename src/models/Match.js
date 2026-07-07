// localpulse/server/src/models/Match.js
import mongoose from 'mongoose';

// A mutual like. `users` holds both ids, always stored sorted so the pair is
// unique regardless of who liked first.
const matchSchema = new mongoose.Schema(
  {
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
    // Unmatched matches are kept but flagged so chat is revoked.
    active: { type: Boolean, default: true },
    lastInteractionAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

matchSchema.index({ users: 1 });
matchSchema.index({ users: 1, active: 1 });

// Serialize for one viewer: show the *other* person + match meta.
matchSchema.methods.toClient = function toClient(viewerId, otherUserDoc) {
  const other = otherUserDoc && otherUserDoc.toCard ? otherUserDoc.toCard() : otherUserDoc;
  return {
    id: this._id,
    user: other,
    conversationId: this.conversation || null,
    active: this.active,
    createdAt: this.createdAt,
    lastInteractionAt: this.lastInteractionAt,
  };
};

export default mongoose.model('Match', matchSchema);
