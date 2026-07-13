// localpulse/server/src/models/Report.js
import mongoose from 'mongoose';


export const REPORT_REASONS = ['spam', 'harassment', 'inappropriate', 'misinformation', 'other'];
export const REPORT_STATUS = ['open', 'reviewed', 'dismissed'];

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Exactly one of post/user is set.
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    reportedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    note: { type: String, maxlength: 500, default: '' },
    status: { type: String, enum: REPORT_STATUS, default: 'open', index: true },
  },
  { timestamps: true }
);

reportSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('Report', reportSchema);
