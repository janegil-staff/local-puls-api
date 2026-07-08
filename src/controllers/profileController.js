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
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

const MIN_AGE = 18;

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
  const { displayName, bio, dob, gender, photos, interests, neighborhood, email, pin, username } = req.body;
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
  user.profileComplete = Boolean(user.dob && user.gender && (user.photos?.length > 0));

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
  if (ageMax !== undefined) user.preferences.ageMax = Math.min(99, Number(ageMax));
  if (maxDistanceKm !== undefined) user.preferences.maxDistanceKm = Math.max(1, Number(maxDistanceKm));

  await user.save();
  res.json({ preferences: user.preferences });
});

// Update last-known location (called by the app when it gets a fix).
export const updateLocation = asyncHandler(async (req, res) => {
  const { lng, lat } = req.body;
  if (lng == null || lat == null) throw ApiError.badRequest('lng and lat required');
  await User.updateOne(
    { _id: req.userId },
    { location: { type: 'Point', coordinates: [Number(lng), Number(lat)] } }
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
