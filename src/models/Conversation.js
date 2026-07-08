// localpulse/server/src/models/Conversation.js
import mongoose from 'mongoose';

// A 1:1 (or small group) conversation. participants sorted for lookup.
// status: 'pending' until the recipient accepts; 'accepted' once they do.
// initiator: who started the conversation (their messages sit in the other
// person's Requests until accepted).
const conversationSchema = new mongoose.Schema(
  {
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
    status: { type: String, enum: ['pending', 'accepted'], default: 'pending' },
    initiator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastMessage: { type: String, default: '' },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

conversationSchema.index({ participants: 1, lastMessageAt: -1 });

export default mongoose.model('Conversation', conversationSchema);