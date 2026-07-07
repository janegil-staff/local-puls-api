// localpulse/server/src/models/Post.js
import mongoose from 'mongoose';

// The typed-post concept is what makes LocalPulse local, not an IG clone.
export const POST_TYPES = ['update', 'event', 'recommendation', 'lostfound', 'marketplace', 'question'];

const postSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: POST_TYPES, default: 'update', index: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    imageUrl: { type: String, default: '' }, // DO Spaces URL later; empty for now
    // Where the post is about. GeoJSON [lng, lat] for "near me" queries.
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] },
    },
    placeName: { type: String, default: '' }, // human label, e.g. "Bergen sentrum"
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

postSchema.index({ location: '2dsphere' });
postSchema.index({ createdAt: -1 });

// Serialize for the client, including whether *this* viewer liked it.
postSchema.methods.toClient = function toClient(viewerId) {
  const a = this.author && this.author.toPublic ? this.author.toPublic() : this.author;
  return {
    id: this._id,
    type: this.type,
    text: this.text,
    imageUrl: this.imageUrl,
    placeName: this.placeName,
    location: this.location,
    author: a,
    likeCount: this.likes.length,
    likedByMe: viewerId ? this.likes.some((id) => String(id) === String(viewerId)) : false,
    createdAt: this.createdAt,
  };
};

export default mongoose.model('Post', postSchema);
