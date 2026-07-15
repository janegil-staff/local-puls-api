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

// A stored photo: the delivery URL, plus the Cloudinary public_id needed to
// destroy it when the account or the photo is deleted.
//
// `publicId` is NOT required. Documents written before this schema existed hold
// bare URL strings, and the migration below promotes them by parsing the id out
// of the URL — a parse that fails on transformed URLs and leaves publicId unset.
// Requiring it would make those users unable to save their profile at all. The
// deletion path skips entries without one, orphaning the asset; a storage cost,
// not a correctness bug.
const photoSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String },
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
    language: { type: String, default: 'en' }, // UI language: no/en/nl/fr/de/it/sv/da/fi/es/pl/pt

    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    banned: { type: Boolean, default: false },
    pushTokens: [{ type: String }],

    // ── Profile ─────────────────────────────────────────
    dob: { type: Date },                 // date of birth (age gate: 18+)
    gender: { type: String, enum: GENDERS },
    // Ordered; photos[0] is the primary. Each entry is { url, publicId } —
    // see photoSchema. Legacy documents hold bare strings; normalizePhotos()
    // below converts them on read, and the migration script converts them at
    // rest.
    photos: [photoSchema],
    interests: [{ type: String }],       // free tags, e.g. "hiking", "coffee"
    neighborhood: { type: String, default: '' }, // local flavor

    // ── Privacy ─────────────────────────────────────────
    // What other users may see about me. Both default to true, matching the
    // behaviour before these fields existed — an account created earlier has
    // them undefined, so every reader must treat undefined as true.
    //
    // These suppress the *output*, not the underlying data: lastSeenAt is still
    // written on every heartbeat (presence drives socket routing), and $geoNear
    // still ranks by real distance. We simply omit the fields from responses.
    showOnlineStatus: { type: Boolean, default: true },
    showDistance: { type: Boolean, default: true },

    // Discovery preferences.
    preferences: {
      show: { type: String, enum: ORIENT_SHOW, default: 'everyone' },
      ageMin: { type: Number, default: 18, min: 18 },
      ageMax: { type: Number, default: 99 },

      // null = "Anywhere", no distance cut-off. This is the DEFAULT: a new
      // user in a sparse area would otherwise land on an empty Discover screen
      // and churn before ever finding the setting. $geoNear still returns
      // nearest-first, so a user in a dense area sees local people regardless.
      //
      // Deliberately NO `min`/`max` here. Mongoose's min validator RUNS on
      // null (null < 1 is true) rather than skipping it, so `min: 1` would
      // reject the very value that means "no limit" — save() throws, the
      // request 500s, and the client's toggle springs back. Range is enforced
      // in profileController.updatePreferences, which knows null is legal.
      maxDistanceKm: { type: Number, default: null },
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

    emailVerified: { type: Boolean, default: false },
    emailVerifyToken: { type: String, index: true },
    emailVerifyExpires: { type: Date },

    pinResetHash: { type: String },
    pinResetExpires: { type: Date },
    pinResetAttempts: { type: Number, default: 0 },
    pinResetRequests: [{ type: Date }],
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
//
// This is the RAW presence check, used for socket routing. It ignores
// showOnlineStatus by design — the flag governs what we tell other users, not
// whether we know. Anything user-facing must go through visibleOnline().
userSchema.methods.isOnline = function isOnline() {
  return Boolean(this.lastSeenAt && Date.now() - new Date(this.lastSeenAt).getTime() < ONLINE_MS);
};

// What OTHER users may see of my presence. `?? true` because accounts created
// before showOnlineStatus existed have it undefined.
userSchema.methods.visibleOnline = function visibleOnline() {
  if ((this.showOnlineStatus ?? true) === false) return false;
  return this.isOnline();
};

// Every serializer below goes through this. A document may hold either the old
// bare-string form or the new { url, publicId } form; the client should never
// have to know which. Legacy strings come back with publicId: null.
export function normalizePhotos(photos) {
  return (photos || []).map((p) => (
    typeof p === 'string'
      ? { url: p, publicId: null }
      : { url: p.url, publicId: p.publicId ?? null }
  ));
}

// The first photo's URL, or ''. Used for avatars.
function primaryUrl(photos) {
  const first = normalizePhotos(photos)[0];
  return first?.url || '';
}

// Minimal public shape — never leak hash/email/dob.
userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id,
    username: this.username,
    displayName: this.displayName || this.username,
    photos: normalizePhotos(this.photos),
    avatarUrl: primaryUrl(this.photos),
    online: this.visibleOnline(),
    role: this.role,
    browseLocationName: this.browseLocationName,
    language: this.language
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
    photos: normalizePhotos(this.photos),
    interests: this.interests || [],
    neighborhood: this.neighborhood,
    locationName: this.locationName || this.neighborhood || '',
    emailVerified: Boolean(this.emailVerified),
    online: this.visibleOnline(),
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
    photos: normalizePhotos(this.photos),
    interests: this.interests || [],
    neighborhood: this.neighborhood,
    preferences: this.preferences,
    profileComplete: this.profileComplete,
    showOnlineStatus: this.showOnlineStatus ?? true,
    showDistance: this.showDistance ?? true,
    locationMode: this.locationMode || 'gps',
    locationName: this.locationName || '',
    browseLocationName: this.browseLocationName || '',
    hasBrowseLocation: Boolean(this.browseLocation?.coordinates?.length),
    emailVerified: Boolean(this.emailVerified),
  };
};

export default mongoose.model('User', userSchema);