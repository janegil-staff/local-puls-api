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
//
// This pipeline builds cards by hand rather than calling User.toCard(),
// because $geoNear returns plain objects, not hydrated documents. That means
// every privacy rule in the model has to be mirrored here — see visibleOnline
// and the showDistance branch below. If you add a flag to toCard(), add it
// here too, or it will leak through Discover.
import mongoose from 'mongoose';
import User, { GENDERS } from '../models/User.js';
import Block from '../models/Block.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

const ONLINE_MS = 2 * 60 * 1000;

// The client sends women/men/everyone; the DB stores female/male. Accept both
// spellings so a stale client (or an old preferences row) still filters
// correctly rather than silently falling through to "everyone".
function gendersFor(show) {
  if (show === 'women' || show === 'female') return ['female'];
  if (show === 'men' || show === 'male') return ['male'];
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
  const hasBrowseOverride = me.browseLocation?.coordinates?.length === 2;
  const browseCoords = hasBrowseOverride
    ? me.browseLocation.coordinates
    : me.location?.coordinates;

  if (!browseCoords?.length) {
    throw ApiError.badRequest(
      'Set your location to see people nearby. Enable location access or pick an area in Settings.',
    );
  }

  const prefs = me.preferences || {};
  const limit = Math.min(Number(req.query.limit) || 40, 60);

  // `null` means "Anywhere" — no distance cut-off. Only `undefined` (field
  // never written) falls back to 50. `??` would collapse null into the
  // default and make the omission below unreachable.
  const maxKm = prefs.maxDistanceKm === undefined ? 50 : prefs.maxDistanceKm;

  const blocks = await Block.find({ $or: [{ blocker: me._id }, { blocked: me._id }] });
  const excludeIds = [me._id];
  blocks.forEach((b) =>
    excludeIds.push(String(b.blocker) === String(me._id) ? b.blocked : b.blocker)
  );

  const geoNear = {
    near: { type: 'Point', coordinates: browseCoords },
    distanceField: 'distanceMeters',
    spherical: true,
    // REQUIRED: the users collection has two 2dsphere indexes (location and
    // browseLocation). Without `key`, MongoDB errors with
    // "more than one 2dsphere index ... unsure which to use for $geoNear".
    // We measure distance to where people *are*, not where they browse.
    key: 'location',
    query: {
      _id: { $nin: excludeIds.map((id) => new mongoose.Types.ObjectId(String(id))) },
      profileComplete: true,
      banned: false,
      // Users who have never reported a position have no `location` at all.
      // Without this they'd be excluded by $geoNear anyway, but being
      // explicit documents the intent.
      'location.coordinates': { $exists: true },
      gender: { $in: gendersFor(prefs.show) },
      dob: dobRangeForAges(prefs.ageMin || 18, prefs.ageMax || 99),
    },
  };

  // Omit maxDistance entirely for "Anywhere". $geoNear streams results
  // nearest-first regardless, so the $limit below still yields the closest N —
  // we just never cut anyone off. Passing Infinity or a huge number would also
  // "work", but defeats the index's early termination.
  if (maxKm != null) geoNear.maxDistance = maxKm * 1000;

  const people = await User.aggregate([
    { $geoNear: geoNear },
    { $limit: limit },
  ]);

  const now = Date.now();
  const list = people.map((u) => {
    // `?? true` — accounts created before these fields existed have them
    // undefined, and undefined must mean "as it behaved before", i.e. visible.
    const showsOnline = u.showOnlineStatus ?? true;
    const showsDistance = u.showDistance ?? true;

    const card = {
      id: u._id,
      username: u.username,
      displayName: u.displayName || u.username,
      age: u.dob ? Math.floor((now - new Date(u.dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : null,
      bio: u.bio,
      photos: u.photos || [],
      interests: u.interests || [],
      neighborhood: u.neighborhood,
      locationName: u.locationName || u.neighborhood || '',
      online: showsOnline
        ? Boolean(u.lastSeenAt && now - new Date(u.lastSeenAt).getTime() < ONLINE_MS)
        : false,
    };

    // Omit the key entirely rather than sending null. A client that renders
    // `{distanceKm} km` would print "null km"; an absent key is falsy and the
    // row simply doesn't appear.
    if (showsDistance) card.distanceKm = displayKm(u.distanceMeters);

    return card;
  });

  res.json({
    users: list,
    people: list,
    deck: list,
    // What the header shows, and whether to offer "browse near me again".
    browsingFrom: hasBrowseOverride
      ? (me.browseLocationName || 'Another area')
      : (me.locationName || null),
    browsingElsewhere: hasBrowseOverride,
  });
});