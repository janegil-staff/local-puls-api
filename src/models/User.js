// localpulse/server/src/models/User.js
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

export const GENDERS = ['female', 'male', 'nonbinary', 'other'];
export const ORIENT_SHOW = ['female', 'male', 'everyone']; // who I want to see

const ONLINE_MS = 2 * 60 * 1000; // "online" = active within the last 2 minutes

// Snap a coordinate to a ~100m grid (3 decimal places). Storing exact
// coordinates lets an attacker with three accounts trilaterate a user's real
// position from the distances the API returns. Snapping collapses everyone in
// the same ~100m cell to identical distances.
const GRID = 1000; // 3 decimals
export function snapCoord(n) {
  return Math.round(Number(n) * GRID) / GRID;
}
export function snapCoords([lng, lat]) {
  return [snapCoord(lng), snapCoord(lat)];
}

// Compute age from a date of birth.
function ageFromDob(dob) {
  if (!dob) return null;
  const diff = Date.now() - new Date(dob).getTime();
  return Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
}

// A GeoJSON point.
//
// This MUST be a real sub-schema, not an inline nested object. Written inline
// as `{ type: { type: {...}, coordinates: {...} }, default: undefined }`,
// Mongoose reads the outer `type:` key as a *type declaration* — so the
// `default: undefined` is a sibling of that declaration and never applies to
// the path. Every new document then materialises a partial `{ type: 'Point' }`
// with no coordinates, which is invalid GeoJSON, and any 2dsphere index over
// the path throws `Can't extract geo keys` on insert.
//
// Declared as a sub-schema, the outer `type: pointSchema` is a genuine type,
// `default: undefined` binds to the path, and `required: true` on the inner
// fields makes a half-formed point fail validation instead of reaching Mongo.
const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: { type: [Number], required: true }, // [lng, lat]
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 24 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    pinHash: { type: String }, // optional 4-6 digit PIN, hashed
    displayName: { type: String, trim: true, maxlength: 40 },
    bio: { type: String, maxlength: 300, default: '' },
    language: { type: String, default: 'no' }, // UI language: no/en/nl/fr/de/it/sv/da/fi/es/pl/pt

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

      // null = "Anywhere", no distance cut-off.
      //
      // Deliberately NO `min`/`max` here. Mongoose's min validator RUNS on
      // null (null < 1 is true) rather than skipping it, so `min: 1` would
      // reject the very value that means "no limit" — save() throws, the
      // request 500s, and the client's toggle springs back. Range is enforced
      // in profileController.updatePreferences, which knows null is legal.
      maxDistanceKm: { type: Number, default: 50 },
    },

    // Whether onboarding is complete enough to appear in discovery.
    profileComplete: { type: Boolean, default: false },

    // Presence: updated on socket connect / heartbeat. "online" is derived.
    lastSeenAt: { type: Date, default: Date.now },

    // Where I appear to be. Coordinates are SNAPPED to a ~100m grid before
    // saving (see snapCoords) so stored positions can't be trilaterated back
    // to an exact home address.
    //
    // Absent entirely until the user reports a position. The old inline
    // definition defaulted this to [0, 0], putting every new account on Null
    // Island (off Ghana), so any two users who hadn't reported GPS yet showed
    // as 0 km apart.
    location: { type: pointSchema, default: undefined },

    locationMode: { type: String, enum: ['gps', 'manual'], default: 'gps' },
    locationName: { type: String, default: '' }, // e.g. "Bergen sentrum"

    // Where I'm browsing. Absent until the user picks somewhere.
    browseLocation: { type: pointSchema, default: undefined },
    browseLocationName: { type: String, default: '' },
  },
  { timestamps: true }
);

// Sparse: `location` is absent until a user reports a position, and a
// non-sparse 2dsphere index over missing paths is wasteful (and errors on
// older MongoDB). Documents without a location simply aren't indexed, which is
// exactly right — they can't appear in $geoNear results anyway.
userSchema.index({ location: '2dsphere' }, { sparse: true });
// NOTE: deliberately NO 2dsphere index on browseLocation. Nothing ever runs a
// geo query against it — it's only read off the viewer's own document to seed
// $geoNear. A second 2dsphere index on this collection makes $geoNear ambiguous
// ("unsure which to use") unless every call passes an explicit `key`.
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
    locationName: this.locationName || this.neighborhood || '',
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
    language: this.language || 'no',
    dob: this.dob,
    age: ageFromDob(this.dob),
    gender: this.gender,
    photos: this.photos || [],
    interests: this.interests || [],
    neighborhood: this.neighborhood,
    preferences: this.preferences,
    profileComplete: this.profileComplete,
    locationMode: this.locationMode || 'gps',
    locationName: this.locationName || '',
    browseLocationName: this.browseLocationName || '',
    hasBrowseLocation: Boolean(this.browseLocation?.coordinates?.length),
  };
};

export default mongoose.model('User', userSchema);