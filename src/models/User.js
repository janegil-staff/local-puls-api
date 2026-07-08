// localpulse/server/src/models/User.js
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

export const GENDERS = ['female', 'male', 'nonbinary', 'other'];
export const ORIENT_SHOW = ['female', 'male', 'everyone']; // who I want to see

const ONLINE_MS = 2 * 60 * 1000; // "online" = active within the last 2 minutes

// Compute age from a date of birth.
function ageFromDob(dob) {
  if (!dob) return null;
  const diff = Date.now() - new Date(dob).getTime();
  return Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
}

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 24 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    pinHash: { type: String }, // optional 4-6 digit PIN, hashed
    displayName: { type: String, trim: true, maxlength: 40 },
    bio: { type: String, maxlength: 300, default: '' },

    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    banned: { type: Boolean, default: false },
    pushTokens: [{ type: String }],

    // ── Profile ─────────────────────────────────────────
    dob: { type: Date },                 // date of birth (age gate: 18+)
    gender: { type: String, enum: GENDERS },
    photos: [{ type: String }],          // ordered photo URLs (first = primary)
    interests: [{ type: String }],       // free tags, e.g. "hiking", "coffee"
    neighborhood: { type: String, default: '' }, // local flavor

    // Discovery preferences.
    preferences: {
      show: { type: String, enum: ORIENT_SHOW, default: 'everyone' },
      ageMin: { type: Number, default: 18, min: 18 },
      ageMax: { type: Number, default: 99 },
      maxDistanceKm: { type: Number, default: 50 },
    },

    // Whether onboarding is complete enough to appear in discovery.
    profileComplete: { type: Boolean, default: false },

    language: { type: String, default: "en" },
    // Presence: updated on socket connect / heartbeat. "online" is derived.
    lastSeenAt: { type: Date, default: Date.now },

    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }, // [lng, lat]
    },
  },
  { timestamps: true }
);

userSchema.index({ location: '2dsphere' });
userSchema.index({ gender: 1, profileComplete: 1 });

userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 12);
};
userSchema.methods.checkPassword = function checkPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};
userSchema.methods.setPin = async function setPin(plain) {
  this.pinHash = await bcrypt.hash(String(plain), 12);
  this.passwordHash = await bcrypt.hash(plain, 12);
};
userSchema.methods.checkPin = function checkPin(plain) {
  if (!this.pinHash) return Promise.resolve(false);
  return bcrypt.compare(String(plain), this.pinHash);
};

userSchema.virtual('age').get(function age() {
  return ageFromDob(this.dob);
});

// Is this user currently online (active within the window)?
userSchema.methods.isOnline = function isOnline() {
  return Boolean(this.lastSeenAt && Date.now() - new Date(this.lastSeenAt).getTime() < ONLINE_MS);
};

// Minimal public shape — never leak hash/email/dob.
userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id,
    username: this.username,
    displayName: this.displayName || this.username,
    photos: this.photos || [],
    avatarUrl: (this.photos && this.photos[0]) || '',
    online: this.isOnline(),
  };
};

// Discovery card — what another user sees when browsing.
userSchema.methods.toCard = function toCard() {
  return {
    id: this._id,
    username: this.username,
    displayName: this.displayName || this.username,
    age: ageFromDob(this.dob),
    bio: this.bio,
    photos: this.photos || [],
    interests: this.interests || [],
    neighborhood: this.neighborhood,
    online: this.isOnline(),
  };
};

// Own full profile (settings screen).
userSchema.methods.toSelf = function toSelf() {
  return {
    id: this._id,
    username: this.username,
    email: this.email,
    displayName: this.displayName || this.username,
    bio: this.bio,
    dob: this.dob,
    age: ageFromDob(this.dob),
    gender: this.gender,
    photos: this.photos || [],
    interests: this.interests || [],
    neighborhood: this.neighborhood,
    preferences: this.preferences,
    profileComplete: this.profileComplete,
  };
};

export default mongoose.model('User', userSchema);