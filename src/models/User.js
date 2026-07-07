// localpulse/server/src/models/User.js
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 24 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    displayName: { type: String, trim: true, maxlength: 40 },
    bio: { type: String, maxlength: 160, default: '' },
    avatarUrl: { type: String, default: '' },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    banned: { type: Boolean, default: false },
    // Expo push tokens for this user's devices.
    pushTokens: [{ type: String }],
    // Last known location for "near me" scoping. GeoJSON [lng, lat].
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }, // [lng, lat]
    },
  },
  { timestamps: true }
);

userSchema.index({ location: '2dsphere' });

userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 12);
};
userSchema.methods.checkPassword = function checkPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

// Public shape — never leak the hash.
userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id,
    username: this.username,
    displayName: this.displayName || this.username,
    bio: this.bio,
    avatarUrl: this.avatarUrl,
  };
};

export default mongoose.model('User', userSchema);
