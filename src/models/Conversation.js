// localpulse/server/src/models/Conversation.js
import mongoose from 'mongoose';

// A 1:1 conversation. status: 'pending' until the recipient accepts;
// 'accepted' once they do. initiator: who started it (their opener sits in the
// other person's Requests until accepted).
//
// pairKey: a DETERMINISTIC identity for the participant pair — the two user ids
// sorted and joined. A unique index on it makes it structurally impossible for
// a pair to have two conversations. Without this, two near-simultaneous
// openConversation calls (both devices opening at once, or a double-tap) each
// run findOne → miss → create, producing duplicate conversations. Messages then
// scatter across the duplicates and "disappear" from whichever one the thread
// happens to load. buildPairKey() below is the single source of truth for the
// format; openConversation must use it too.
const conversationSchema = new mongoose.Schema(
  {
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
    pairKey: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'accepted'], default: 'pending' },
    initiator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastMessage: { type: String, default: '' },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

conversationSchema.index({ participants: 1, lastMessageAt: -1 });

// Sorted, joined pair of user ids. Order-independent so (A,B) and (B,A) collide
// on the same key. Accepts ObjectIds or strings.
export function buildPairKey(a, b) {
  return [String(a), String(b)].sort().join('_');
}

export default mongoose.model('Conversation', conversationSchema);