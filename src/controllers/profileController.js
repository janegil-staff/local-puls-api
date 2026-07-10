// localpulse/server/src/controllers/profileController.js
import User, { GENDERS, ORIENT_SHOW } from '../models/User.js';
import Swipe from '../models/Swipe.js';
import Match from '../models/Match.js';
import Message from '../models/Message.js';
import Conversation from '../models/Conversation.js';
import Block from '../models/Block.js';
import Report from '../models/Report.js';
import Notification from '../models/Notification.js';
import Post from '../models/Post.js';
import Comment from '../models/Comment.js';
import Follow from '../models/Follow.js';
import SavedPost from '../models/SavedPost.js';
import { snapCoords } from './locationController.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { destroyImages } from '../lib/cloudinary.js';

const MIN_AGE = 18;
const MAX_AGE = 99;
const MIN_DISTANCE_KM = 1;
const MAX_DISTANCE_KM = 500;

// Must match SUPPORTED_LANGS in the app's i18n/translations.js. A value outside
// this set would render every string through the English fallback, which looks
// like a bug rather than a rejection.
const SUPPORTED_LANGS = ['no', 'en', 'nl', 'fr', 'de', 'it', 'sv', 'da', 'fi', 'es', 'pl', 'pt'];

function ageFromDob(dob) {
  return Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
}

// Return own full profile.
export const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) throw ApiError.notFound('User not found');
  res.json({ profile: user.toSelf() });
});

// Update dating profile. Enforces the 18+ age gate on DOB.
export const updateProfile = asyncHandler(async (req, res) => {
  const {
    displayName, bio, dob, gender, photos, interests, neighborhood,
    email, pin, username, language, showOnlineStatus, showDistance,
  } = req.body;
  const user = await User.findById(req.userId);
  if (!user) throw ApiError.notFound('User not found');

  if (dob !== undefined) {
    const age = ageFromDob(dob);
    if (Number.isNaN(age)) throw ApiError.badRequest('Invalid date of birth');
    if (age < MIN_AGE) throw ApiError.badRequest('You must be at least 18 to use this app');
    user.dob = dob;
  }
  if (gender !== undefined) {
    if (!GENDERS.includes(gender)) throw ApiError.badRequest('Invalid gender');
    user.gender = gender;
  }
  if (displayName !== undefined) user.displayName = displayName;
  if (bio !== undefined) user.bio = bio;
  if (photos !== undefined) {
    if (!Array.isArray(photos)) throw ApiError.badRequest('photos must be an array');
    user.photos = photos.slice(0, 6);
  }
  if (interests !== undefined) user.interests = (interests || []).slice(0, 10);
  if (neighborhood !== undefined) user.neighborhood = neighborhood;

  // UI language. Previously absent from this destructure, so the onboarding
  // flow's `updateMyProfile({ language })` call was a silent no-op and every
  // account kept the 'no' default regardless of what the user picked.
  if (language !== undefined) {
    if (!SUPPORTED_LANGS.includes(language)) throw ApiError.badRequest('Unsupported language');
    user.language = language;
  }

  // Privacy flags. Coerce explicitly: a client sending the string "false" would
  // otherwise be truthy and silently enable what the user just turned off.
  if (showOnlineStatus !== undefined) {
    if (typeof showOnlineStatus !== 'boolean') throw ApiError.badRequest('showOnlineStatus must be a boolean');
    user.showOnlineStatus = showOnlineStatus;
  }
  if (showDistance !== undefined) {
    if (typeof showDistance !== 'boolean') throw ApiError.badRequest('showDistance must be a boolean');
    user.showDistance = showDistance;
  }

  // Username: a login identifier, so check uniqueness (no PIN needed).
  if (username !== undefined && username !== user.username) {
    const uname = String(username).trim();
    if (uname.length < 3 || uname.length > 24) {
      throw ApiError.badRequest('Username must be 3 to 24 characters');
    }
    const taken = await User.findOne({ username: uname, _id: { $ne: user._id } });
    if (taken) throw ApiError.badRequest('Username already in use');
    user.username = uname;
  }

  // Email is a login credential — require the PIN and check uniqueness.
  if (email !== undefined && email !== user.email) {
    const normalized = String(email).toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw ApiError.badRequest('Invalid email');
    }
    const ok = await user.checkPin(String(pin || ''));
    if (!ok) throw ApiError.badRequest('Incorrect PIN');
    const taken = await User.findOne({ email: normalized, _id: { $ne: user._id } });
    if (taken) throw ApiError.badRequest('Email already in use');
    user.email = normalized;
  }

  // Profile counts as complete when the essentials are present.
  user.profileComplete = Boolean(user.dob && user.gender);

  await user.save();
  res.json({ profile: user.toSelf() });
});

// Update discovery preferences.
export const updatePreferences = asyncHandler(async (req, res) => {
  const { show, ageMin, ageMax, maxDistanceKm } = req.body;
  const user = await User.findById(req.userId);
  if (!user) throw ApiError.notFound('User not found');

  if (show !== undefined) {
    if (!ORIENT_SHOW.includes(show)) throw ApiError.badRequest('Invalid show preference');
    user.preferences.show = show;
  }
  if (ageMin !== undefined) user.preferences.ageMin = Math.max(MIN_AGE, Number(ageMin));
  if (ageMax !== undefined) user.preferences.ageMax = Math.min(MAX_AGE, Number(ageMax));

  // `null` means "Anywhere" — no distance cut-off. It must be handled BEFORE
  // any arithmetic: Number(null) is 0, so the old `Math.max(1, Number(null))`
  // silently became 1, saved a 1km radius, and returned 200. To the client
  // that looked like the toggle saved and then sprang back.
  //
  // Explicitly assigning null persists it — the schema default only applies at
  // document creation, not on save.
  if (maxDistanceKm !== undefined) {
    if (maxDistanceKm === null) {
      user.preferences.maxDistanceKm = null;
    } else {
      const n = Number(maxDistanceKm);
      if (!Number.isFinite(n)) throw ApiError.badRequest('maxDistanceKm must be a number');
      user.preferences.maxDistanceKm = Math.min(MAX_DISTANCE_KM, Math.max(MIN_DISTANCE_KM, n));
    }
  }

  if (user.preferences.ageMin > user.preferences.ageMax) {
    throw ApiError.badRequest('Minimum age cannot exceed maximum age');
  }

  await user.save();
  res.json({ preferences: user.preferences });
});

// Update last-known location (called by the app when it gets a fix).
//
// NOTE: this is a second write path for `location`, alongside
// locationController.setLocation. It exists for background GPS pushes from
// Discover/Feed, which have no place name to attach. It MUST snap like the
// other path does — an unsnapped write here would store an exact position and
// defeat the grid entirely, since an attacker only needs the target to have
// used the app once with location on.
export const updateLocation = asyncHandler(async (req, res) => {
  const { lng, lat } = req.body;
  if (lng == null || lat == null) throw ApiError.badRequest('lng and lat required');

  const lngN = Number(lng);
  const latN = Number(lat);
  if (!Number.isFinite(lngN) || !Number.isFinite(latN)) {
    throw ApiError.badRequest('lng and lat must be numbers');
  }
  if (latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
    throw ApiError.badRequest('coordinates out of range');
  }

  // Don't clobber a hand-picked location with a background GPS push. Mirrors
  // the guard in locationController.setLocation.
  const user = await User.findById(req.userId).select('locationMode');
  if (!user) throw ApiError.unauthorized();
  if (user.locationMode === 'manual') {
    return res.json({ ok: true, skipped: 'manual mode active' });
  }

  await User.updateOne(
    { _id: req.userId },
    { location: { type: 'Point', coordinates: snapCoords([lngN, latN]) } },
  );
  res.json({ ok: true });
});

// Full account deletion — App Store Guideline 5.1.1 requires this in-app.
// Removes the user and all data derived from them.
export const deleteAccount = asyncHandler(async (req, res) => {
  const uid = req.userId;

  const matches = await Match.find({ users: uid }).select('conversation');
  const convoIds = matches.map((m) => m.conversation).filter(Boolean);

  await Promise.all([
    User.deleteOne({ _id: uid }),
    Swipe.deleteMany({ $or: [{ user: uid }, { target: uid }] }),
    Match.deleteMany({ users: uid }),
    Block.deleteMany({ $or: [{ blocker: uid }, { blocked: uid }] }),
    Report.deleteMany({ $or: [{ reporter: uid }, { reportedUser: uid }] }),
    Notification.deleteMany({ $or: [{ user: uid }, { actor: uid }] }),
    Message.deleteMany({ sender: uid }),
    Conversation.deleteMany({ _id: { $in: convoIds } }),
    // Feed-side cleanup (hybrid app).
    Post.deleteMany({ author: uid }),
    Comment.deleteMany({ author: uid }),
    Follow.deleteMany({ $or: [{ follower: uid }, { following: uid }] }),
    SavedPost.deleteMany({ user: uid }),
  ]);

  res.json({ ok: true, deleted: true });
});

// Full account deletion — App Store Guideline 5.1.1 requires this in-app.
// Removes the user, all data derived from them, and their uploaded images.
export const deleteAccount = asyncHandler(async (req, res) => {
  const uid = req.userId;

  // Collect image URLs BEFORE deleting the documents that hold them.
  const [user, posts, messages] = await Promise.all([
    User.findById(uid).select('photos'),
    Post.find({ author: uid }).select('imageUrl'),
    Message.find({ sender: uid, imageUrl: { $exists: true } }).select('imageUrl'),
  ]);

  const imageUrls = [
    ...(user?.photos ?? []),
    ...posts.map((p) => p.imageUrl).filter(Boolean),
    ...messages.map((m) => m.imageUrl).filter(Boolean),
  ];

  // Comments on the user's posts, and saves of them, would otherwise be
  // orphaned — Post.deleteMany doesn't cascade.
  const postIds = posts.map((p) => p._id);

  // Conversations the user is a participant in. The old code went via Match,
  // which misses conversations created by openConversation() without a match.
  const convos = await Conversation.find({ participants: uid }).select('_id');
  const convoIds = convos.map((c) => c._id);

  await Promise.all([
    User.deleteOne({ _id: uid }),
    Swipe.deleteMany({ $or: [{ user: uid }, { target: uid }] }),
    Match.deleteMany({ users: uid }),
    Block.deleteMany({ $or: [{ blocker: uid }, { blocked: uid }] }),
    Report.deleteMany({ $or: [{ reporter: uid }, { reportedUser: uid }] }),
    Notification.deleteMany({ $or: [{ user: uid }, { actor: uid }] }),

    // Every message in the user's conversations, not just the ones they sent —
    // otherwise the other participant's half survives with no conversation.
    Message.deleteMany({ conversation: { $in: convoIds } }),
    Conversation.deleteMany({ _id: { $in: convoIds } }),

    // Feed-side cleanup.
    Post.deleteMany({ author: uid }),
    Comment.deleteMany({ $or: [{ author: uid }, { post: { $in: postIds } }] }),
    SavedPost.deleteMany({ $or: [{ user: uid }, { post: { $in: postIds } }] }),
    Follow.deleteMany({ $or: [{ follower: uid }, { following: uid }] }),
  ]);

  // Fire and forget. The account is gone; a Cloudinary failure shouldn't turn
  // a successful deletion into a 500 the client retries against a dead user.
  destroyImages(imageUrls);

  res.json({ ok: true, deleted: true });
});