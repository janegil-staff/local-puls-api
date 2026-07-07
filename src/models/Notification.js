// localpulse/server/src/models/Notification.js
import mongoose from 'mongoose';

export const NOTIF_TYPES = ['like', 'comment', 'follow', 'message', 'match'];

const notificationSchema = new mongoose.Schema(
  {
    // Who receives the notification.
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Who triggered it.
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIF_TYPES, required: true },
    // Optional targets depending on type.
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, createdAt: -1 });

notificationSchema.methods.toClient = function toClient() {
  const actor = this.actor && this.actor.toPublic ? this.actor.toPublic() : this.actor;
  return {
    id: this._id,
    type: this.type,
    actor,
    postId: this.post,
    read: this.read,
    createdAt: this.createdAt,
  };
};

export default mongoose.model('Notification', notificationSchema);
