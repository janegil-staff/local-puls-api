// localpulse/server/src/models/Swipe.js
import mongoose from 'mongoose';

// One decision by `user` about `target`. 'like' or 'pass'.
// Used to (a) detect mutual likes → matches, (b) exclude already-seen users
// from discovery.
const swipeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    target: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, enum: ['like', 'pass'], required: true },
  },
  { timestamps: true }
);

// One decision per pair — re-swiping updates rather than duplicates.
swipeSchema.index({ user: 1, target: 1 }, { unique: true });

export default mongoose.model('Swipe', swipeSchema);
