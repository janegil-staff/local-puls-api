// localpulse/server/src/models/Message.js
import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Required only for text messages. An image message carries an imageUrl
    // and no text — hence the function form rather than `true`.
    text: {
      type: String,
      trim: true,
      maxlength: 2000,
      required: function requiredWithoutImage() { return !this.imageUrl; },
    },
    // A URL returned by the /upload route. Absent on text messages.
    imageUrl: { type: String },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: 1 });

messageSchema.methods.toClient = function toClient() {
  const s = this.sender && this.sender.toPublic ? this.sender.toPublic() : this.sender;
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

export default mongoose.model('Message', messageSchema);