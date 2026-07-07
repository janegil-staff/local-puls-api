// localpulse/server/src/models/Message.js
import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
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
    createdAt: this.createdAt,
  };
};

export default mongoose.model('Message', messageSchema);
