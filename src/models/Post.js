// localpulse/server/src/models/Post.js
import mongoose from 'mongoose';

// The typed-post concept is what makes LocalPulse local, not an IG clone.
export const POST_TYPES = ['update', 'event', 'recommendation', 'lostfound', 'marketplace', 'question'];

const postSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: POST_TYPES, default: 'update', index: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    imageUrl: { type: String, default: '' },

    // Where the post is about. GeoJSON [lng, lat].
    //
    // NO `default` here on purpose: an unset location must be genuinely absent,
    // not stranded on Null Island (0,0) where it would show up ~7000km from
    // real users. Mongoose REJECTS `default: undefined` on a nested path with
    // "Invalid value for schema path location.default" — so we simply omit the
    // default. Absent field = absent location, which the sparse index below
    // handles correctly.
    location: {
      type: {
        type: String,
        enum: ['Point'],
      },
      coordinates: {
        type: [Number],
      },
    },

    placeName: { type: String, default: '' },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

// Sparse so posts WITHOUT a location don't error and aren't indexed as (0,0).
postSchema.index({ location: '2dsphere' }, { sparse: true });
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