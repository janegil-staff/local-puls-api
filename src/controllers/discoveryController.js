// localpulse/server/src/controllers/discoveryController.js
import User, { GENDERS } from '../models/User.js';
import Swipe from '../models/Swipe.js';
import Block from '../models/Block.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

// Map a viewer's "show" preference to the set of genders to surface.
function gendersFor(show) {
  if (show === 'women') return ['woman'];
  if (show === 'men') return ['man'];
  return GENDERS; // everyone
}

// Convert an age range to a DOB window. Someone aged N was born between
// (today - (N+1) years) and (today - N years).
function dobRangeForAges(min, max) {
  const now = Date.now();
  const yearMs = 365.25 * 24 * 60 * 60 * 1000;
  return {
    // oldest allowed birth date → the max age boundary
    $gte: new Date(now - (max + 1) * yearMs),
    // youngest allowed → the min age boundary
    $lte: new Date(now - min * yearMs),
  };
}

// The discovery deck: candidates near the viewer, matching preferences,
// excluding themselves, anyone already swiped, and blocks (both directions).
export const getDeck = asyncHandler(async (req, res) => {
  const me = await User.findById(req.userId);
  if (!me) throw ApiError.unauthorized();
  if (!me.profileComplete) throw ApiError.badRequest('Complete your profile first');
  if (!me.location?.coordinates?.length) throw ApiError.badRequest('Location required for discovery');

  const prefs = me.preferences || {};
  const limit = Math.min(Number(req.query.limit) || 20, 40);

  // Ids to exclude: myself + everyone I've already swiped + blocks both ways.
  const [swipes, blocks] = await Promise.all([
    Swipe.find({ user: me._id }).select('target'),
    Block.find({ $or: [{ blocker: me._id }, { blocked: me._id }] }),
  ]);
  const excludeIds = new Set([String(me._id)]);
  swipes.forEach((s) => excludeIds.add(String(s.target)));
  blocks.forEach((b) =>
    excludeIds.add(String(String(b.blocker) === String(me._id) ? b.blocked : b.blocker))
  );

  const maxMeters = (prefs.maxDistanceKm || 50) * 1000;

  const candidates = await User.find({
    _id: { $nin: [...excludeIds].map((id) => id) },
    profileComplete: true,
    banned: false,
    gender: { $in: gendersFor(prefs.show) },
    dob: dobRangeForAges(prefs.ageMin || 18, prefs.ageMax || 99),
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: me.location.coordinates },
        $maxDistance: maxMeters,
      },
    },
  }).limit(limit);

  res.json({ deck: candidates.map((u) => u.toCard()) });
});
