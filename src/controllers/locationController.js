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

// ── Geocoding via Photon (Komoot, OSM-backed) ──────────────────────────
// Photon is built for AUTOCOMPLETE: it indexes prefixes, so "berg" returns
// Bergen immediately. Nominatim is a full-text geocoder and handles partial
// input badly — hence Photon here.
//
// Free, no API key. Called server-side only: keeps the user's search off a
// third party per-device, lets us cache, and keeps rate limiting in one place.
//
// Optional env:
//   PHOTON_URL   — self-hosted instance (recommended if this gets busy)
//   PHOTON_UA    — descriptive User-Agent, e.g. "LocalPulse/1.0 (you@qupda.com)"
const PHOTON_URL = process.env.PHOTON_URL || 'https://photon.komoot.io/api';
const UA = process.env.PHOTON_UA || 'LocalPulse/1.0 (contact@example.com)';

// Optionally restrict results to one country. Photon has no country parameter,
// so we filter server-side on `countrycode` — an ISO code, stable across
// languages (unlike `country`, which is localised: "Norge" vs "Norway").
// Set GEOCODE_COUNTRY=NO while LocalPulse is Norway-only; unset it to expand.
const ONLY_COUNTRY = (process.env.GEOCODE_COUNTRY || '').toUpperCase() || null;

// Bias results toward the user's current position so "sentrum" means *their*
// sentrum. Photon takes lat/lon as a soft bias, not a hard filter.
function biasParams(user) {
  const c = user?.location?.coordinates;
  if (!c || c.length !== 2 || (c[0] === 0 && c[1] === 0)) return '';
  return `&lat=${c[1]}&lon=${c[0]}`;
}

// Tiny in-memory cache: key → { at, results }. Place coordinates don't move.
const cache = new Map();
const CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;

function cacheSet(key, results) {
  if (cache.size >= CACHE_MAX) {
    // drop oldest
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { at: Date.now(), results });
}

// Photon returns GeoJSON features. Build a short label out of the properties.
function labelFor(props) {
  const { name, city, town, village, district, county, state, country } = props;
  const local = name || district || city || town || village || '';
  const region = (city && city !== local) ? city : (town || village || county || state || '');
  if (local && region && local !== region) return `${local}, ${region}`;
  return local || region || country || '';
}

// Prefer places people would actually pick: cities, towns, suburbs, villages.
// Photon's osm_value tells us what kind of thing this is.
const GOOD_VALUES = new Set([
  'city', 'town', 'village', 'suburb', 'neighbourhood', 'quarter',
  'borough', 'municipality', 'hamlet', 'county', 'state', 'island',
]);

export const geocode = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  // Autocomplete from the second character — that's the point of Photon.
  if (q.length < 2) return res.json({ results: [] });

  const me = await User.findById(req.userId).select('location');
  const bias = biasParams(me);
  const key = `${q.toLowerCase()}|${bias}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.json({ results: hit.results, cached: true });
  }

  const url = `${PHOTON_URL}?q=${encodeURIComponent(q)}&limit=10${bias}&lang=default`;

  let raw;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error(`photon ${r.status}`);
    raw = await r.json();
  } catch (err) {
    console.error('geocode error', err.message);
    throw ApiError.badRequest('Place search is unavailable right now');
  }

  const seen = new Set();
  const results = (raw.features || [])
    .filter((f) => GOOD_VALUES.has(f.properties?.osm_value))
    .map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties;
      return {
        name: labelFor(p),
        fullName: [p.name, p.city, p.county, p.state, p.country].filter(Boolean).join(', '),
        country: p.country || '',
        countryCode: p.countrycode || '',
        // Snap on the way in so we never even hold a precise value.
        lat: snap(lat),
        lng: snap(lon),
      };
    })
    .filter((p) => {
      if (!p.name) return false;
      if (ONLY_COUNTRY && p.countryCode !== ONLY_COUNTRY) return false;
      // Dedupe on the LABEL, not coordinates: Photon can return the same place
      // as both a county and a municipality with different centroids, which
      // would otherwise render as two identical-looking rows ("Oslo", "Oslo").
      // Results are rank-ordered, so the first hit is the best one.
      const k = p.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8);

  cacheSet(key, results);
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

  // A user who set their location by hand should not have it silently
  // overwritten by a background GPS push from Discover/Feed. Only an explicit
  // update (mode given) may change it once manual mode is on.
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

// ── Set where I'm browsing (clear → fall back to my own location) ──────
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