// localpulse/server/src/models/Comment.js
import mongoose from 'mongoose';

const commentSchema = new mongoose.Schema(
  {
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true, maxlength: 500 },
    isSeedPost: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

commentSchema.index({ post: 1, createdAt: 1 });

commentSchema.methods.toClient = function toClient() {
  const a = this.author && this.author.toPublic ? this.author.toPublic() : this.author;
  return {
    id: this._id,
    text: this.text,
    author: a,
    createdAt: this.createdAt,
  };
};

export default mongoose.model('Comment', commentSchema);
