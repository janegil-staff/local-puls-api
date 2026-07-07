// localpulse/server/src/models/Block.js
import mongoose from 'mongoose';

// `blocker` blocks `blocked`. Used to filter feed, hide posts, prevent messaging.
const blockSchema = new mongoose.Schema(
  {
    blocker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    blocked: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true }
);

blockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });

export default mongoose.model('Block', blockSchema);
