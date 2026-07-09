// localpulse/server/src/controllers/locationController.js
//
// Location handling for LocalPulse.
//
// PRIVACY: coordinates are snapped to a ~100m grid before they are stored.
// This matters because an attacker with three accounts at known positions can
// trilaterate a target from three distance readings — rounding only the
// *displayed* distance does not prevent this, but snapping the *stored*
// coordinates does: everyone in the same grid cell reports identical
// distances, so trilateration resolves to a cell, never a person.
import User from '../models/User.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

// ~100m at Norwegian latitudes. 3 decimal places of a degree.
const GRID = 1000;
export const snap = (n) => Math.round(Number(n) * GRID) / GRID;
export const snapCoords = ([lng, lat]) => [snap(lng), snap(lat)];

// ── Geocoding via Nominatim (OpenStreetMap) ────────────────────────────
// Called server-side only: keeps the user's search off third-party servers
// per-device, lets us cache, and keeps us inside Nominatim's rate limit.
//
// Nominatim usage policy requires a descriptive User-Agent with contact info.
// Set NOMINATIM_UA in your env, e.g.
//   NOMINATIM_UA="LocalPulse/1.0 (contact@qupda.com)"
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = process.env.NOMINATIM_UA || 'LocalPulse/1.0 (contact@example.com)';

// Tiny in-memory cache: query → { at, results }. Nominatim allows 1 req/sec;
// caching keeps repeat searches free and well inside the limit.
const cache = new Map();
const CACHE_MS = 24 * 60 * 60 * 1000; // 24h — place coordinates don't move

export const geocode = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });

  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.json({ results: hit.results, cached: true });
  }

  const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=json&limit=8&addressdetails=1`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'no,en' } });
  if (!r.ok) throw ApiError.badRequest('Location search is unavailable right now');
  const raw = await r.json();

  const results = raw.map((p) => {
    const a = p.address || {};
    const short =
      a.suburb || a.neighbourhood || a.city_district ||
      a.city || a.town || a.village || a.municipality || p.name || '';
    const region = a.city || a.municipality || a.county || '';
    const label = short && region && short !== region ? `${short}, ${region}` : (short || p.display_name);
    return {
      name: label,
      fullName: p.display_name,
      // Snap on the way in so we never even hold a precise value.
      lat: snap(p.lat),
      lng: snap(p.lon),
    };
  });

  cache.set(key, { at: Date.now(), results });
  res.json({ results });
});

// ── Set where I appear to be ───────────────────────────────────────────
// body: { lat, lng, name?, mode: 'gps' | 'manual' }
export const setLocation = asyncHandler(async (req, res) => {
  const { lat, lng, name, mode } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw ApiError.badRequest('lat and lng are required');
  }
  if (mode && !['gps', 'manual'].includes(mode)) {
    throw ApiError.badRequest('mode must be "gps" or "manual"');
  }
  const user = await User.findById(req.userId);
  if (!user) throw ApiError.unauthorized();

  // A user in manual mode should not have their choice silently overwritten by
  // a background GPS push. Only a manual update (or an explicit switch back to
  // gps) may change the location once manual mode is on.
  if (user.locationMode === 'manual' && mode !== 'manual' && mode !== 'gps') {
    return res.json({ ok: true, skipped: 'manual mode active' });
  }
  if (user.locationMode === 'manual' && !mode) {
    return res.json({ ok: true, skipped: 'manual mode active' });
  }

  user.location = { type: 'Point', coordinates: snapCoords([lng, lat]) };
  if (mode) user.locationMode = mode;
  if (typeof name === 'string') user.locationName = name;
  await user.save();

  res.json({
    ok: true,
    location: user.location.coordinates,
    locationMode: user.locationMode,
    locationName: user.locationName,
  });
});

// ── Set where I'm browsing (null coords → clear, use my own location) ──
// body: { lat, lng, name } | { clear: true }
export const setBrowseLocation = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) throw ApiError.unauthorized();

  if (req.body?.clear) {
    user.browseLocation = undefined;
    user.browseLocationName = '';
    await user.save();
    return res.json({ ok: true, cleared: true });
  }

  const { lat, lng, name } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw ApiError.badRequest('lat and lng are required');
  }
  user.browseLocation = { type: 'Point', coordinates: snapCoords([lng, lat]) };
  user.browseLocationName = typeof name === 'string' ? name : '';
  await user.save();

  res.json({
    ok: true,
    browseLocation: user.browseLocation.coordinates,
    browseLocationName: user.browseLocationName,
  });
});