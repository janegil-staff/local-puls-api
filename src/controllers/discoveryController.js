// localpulse/server/src/controllers/discoveryController.js
//
// People nearby (open local chat model). Returns users near the viewer's
// BROWSE location (falls back to their own location), excluding themselves and
// anyone blocked in either direction. No swipe-exclusion — matching is gone.
//
// Distances come from $geoNear and are rounded before they leave the server.
// Stored coordinates are already snapped to a ~100m grid (see
// locationController.snapCoords), which is what actually defeats
// trilateration; the rounding here is purely cosmetic.
import mongoose from 'mongoose';
import User, { GENDERS } from '../models/User.js';
import Block from '../models/Block.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

const ONLINE_MS = 2 * 60 * 1000;

function gendersFor(show) {
  if (show === 'female') return ['female'];
  if (show === 'male') return ['male'];
  return GENDERS;
}

function dobRangeForAges(min, max) {
  const now = Date.now();
  const yearMs = 365.25 * 24 * 60 * 60 * 1000;
  return {
    $gte: new Date(now - (max + 1) * yearMs),
    $lte: new Date(now - min * yearMs),
  };
}

// Round to one decimal km, with a floor so nobody reads as "0 km away".
function displayKm(meters) {
  const km = meters / 1000;
  if (km < 1) return Math.max(0.1, Math.round(km * 10) / 10);
  return Math.round(km * 10) / 10;
}

export const getDeck = asyncHandler(async (req, res) => {
  const me = await User.findById(req.userId);
  if (!me) throw ApiError.unauthorized();
  if (!me.profileComplete) throw ApiError.badRequest('Complete your profile first');

  // Browse from the chosen browse location if set, else my own location.
  const browseCoords =
    me.browseLocation?.coordinates?.length === 2
      ? me.browseLocation.coordinates
      : me.location?.coordinates;

  if (!browseCoords?.length) throw ApiError.badRequest('Location required for discovery');

  const prefs = me.preferences || {};
  const limit = Math.min(Number(req.query.limit) || 40, 60);
  const maxMeters = (prefs.maxDistanceKm || 50) * 1000;

  const blocks = await Block.find({ $or: [{ blocker: me._id }, { blocked: me._id }] });
  const excludeIds = [me._id];
  blocks.forEach((b) =>
    excludeIds.push(String(b.blocker) === String(me._id) ? b.blocked : b.blocker)
  );

  const people = await User.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: browseCoords },
        distanceField: 'distanceMeters',
        maxDistance: maxMeters,
        spherical: true,
        query: {
          _id: { $nin: excludeIds.map((id) => new mongoose.Types.ObjectId(String(id))) },
          profileComplete: true,
          banned: false,
          gender: { $in: gendersFor(prefs.show) },
          dob: dobRangeForAges(prefs.ageMin || 18, prefs.ageMax || 99),
        },
      },
    },
    { $limit: limit },
  ]);

  const now = Date.now();
  const list = people.map((u) => ({
    id: u._id,
    username: u.username,
    displayName: u.displayName || u.username,
    age: u.dob ? Math.floor((now - new Date(u.dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : null,
    bio: u.bio,
    photos: u.photos || [],
    interests: u.interests || [],
    neighborhood: u.neighborhood,
    locationName: u.locationName || u.neighborhood || '',
    online: Boolean(u.lastSeenAt && now - new Date(u.lastSeenAt).getTime() < ONLINE_MS),
    distanceKm: displayKm(u.distanceMeters),
  }));

  res.json({
    users: list,
    people: list,
    deck: list,
    browsingFrom: me.browseLocationName || me.locationName || null,
  });
});