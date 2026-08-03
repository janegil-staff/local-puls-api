// localpulse/server/src/models/Report.js
import mongoose from "mongoose";

export const REPORT_REASONS = [
  "spam",
  "harassment",
  "inappropriate",
  "misinformation",
  "other",
];
export const REPORT_STATUS = ["open", "reviewed", "dismissed"];

const reportSchema = new mongoose.Schema(
  {
    reporter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Exactly one of post/message/reportedUser-alone is set. A MESSAGE report
    // also sets reportedUser (to the sender) so that queries which group by
    // reported user — the moderation queue's "who is this about" view — pick
    // message reports up without any change. Read `message` first when
    // rendering: if it is set, this is about one message inside a thread, not
    // about the person in general.
    post: { type: mongoose.Schema.Types.ObjectId, ref: "Post" },
    message: { type: mongoose.Schema.Types.ObjectId, ref: "Message" },
    // Carried alongside `message` so the queue can load surrounding context.
    // A single line lifted out of a conversation is usually unreadable — the
    // moderator needs what came before and after to judge it.
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation" },
    // The message text AS REPORTED. Messages are not editable today, so this
    // is insurance rather than a requirement — but the day editing lands, a
    // report that reads the live document becomes worthless. Cheap now,
    // impossible to backfill later.
    snapshotText: { type: String, maxlength: 2000, default: "" },
    reportedUser: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    note: { type: String, maxlength: 500, default: "" },
    status: { type: String, enum: REPORT_STATUS, default: "open", index: true },
  },
  { timestamps: true },
);

reportSchema.index({ status: 1, createdAt: -1 });
// One report per person per message. Filing twice is a no-op rather than an
// error — see reportMessage() — but the index makes that guarantee real even
// under a double-tap race. Sparse so the millions of non-message reports do
// not all collide on null.
reportSchema.index({ reporter: 1, message: 1 }, { unique: true, sparse: true });

export default mongoose.model("Report", reportSchema);
