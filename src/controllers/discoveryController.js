// localpulse/server/src/controllers/discoveryController.js
// People nearby (open local chat model). Returns a list of users near the
// viewer, excluding themselves and anyone blocked (either direction).
// No swipe-exclusion — matching has been removed.
import User, { GENDERS } from '../models/User.js';
import Block from '../models/Block.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

// Map a viewer's "show" preference to the set of genders to surface.
function gendersFor(show) {
  if (show === 'female') return ['female'];
  if (show === 'male') return ['male'];
  return GENDERS; // everyone
}

// Convert an age range to a DOB window.
function dobRangeForAges(min, max) {
  const now = Date.now();
  const yearMs = 365.25 * 24 * 60 * 60 * 1000;
  return {
    $gte: new Date(now - (max + 1) * yearMs),
    $lte: new Date(now - min * yearMs),
  };
}

export const getDeck = asyncHandler(async (req, res) => {
  const me = await User.findById(req.userId);
  if (!me) throw ApiError.unauthorized ? ApiError.unauthorized() : ApiError.badRequest('Unauthorized');
  if (!me.profileComplete) throw ApiError.badRequest('Complete your profile first');
  if (!me.location?.coordinates?.length) throw ApiError.badRequest('Location required for discovery');

  const prefs = me.preferences || {};
  const limit = Math.min(Number(req.query.limit) || 40, 60);

  // Exclude myself + blocks in both directions.
  const blocks = await Block.find({ $or: [{ blocker: me._id }, { blocked: me._id }] });
  const excludeIds = new Set([String(me._id)]);
  blocks.forEach((b) =>
    excludeIds.add(String(String(b.blocker) === String(me._id) ? b.blocked : b.blocker))
  );

  const maxMeters = (prefs.maxDistanceKm || 50) * 1000;

  const people = await User.find({
    _id: { $nin: [...excludeIds] },
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

  // Return under both keys so the client grid (which reads users/people/deck)
  // works regardless.
  const list = people.map((u) => u.toCard());
  res.json({ users: list, people: list, deck: list });
});