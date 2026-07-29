// localpulse/server/src/lib/interests.js
//
// The canonical interest list. This is the source of truth — the app has its
// own copy in components/InterestsEditor.js and the two MUST stay in step.
//
// Two copies is a real drift risk: add one here and the server accepts a
// value the app cannot render a label for; add one there and saves fail
// validation with no useful message. If this list starts changing often,
// expose it as GET /api/interests and have the app fetch it, so a new
// interest does not need an app-store release.
//
// Values are stable ids, never display text. Labels live in the app's locale
// files under `interest_<id>` so they translate into all 12 languages.

export const INTERESTS = [
  "hiking",
  "coffee",
  "travel",
  "photography",
  "music",
  "food",
  "fitness",
  "running",
  "art",
  "books",
  "gaming",
  "cooking",
  "cycling",
  "yoga",
  "movies",
  "dancing",
  "design",
  "nature",
  "concerts",
  "fashion",
  "technology",
  "football",
  "climbing",
  "baking",
];

const INTEREST_SET = new Set(INTERESTS);

export const MAX_INTERESTS = 8;

/**
 * Cleans an interests array from a request body.
 *
 * Rejects rather than silently trims, because a silent trim means the user
 * taps eight, sees eight, saves, and gets six back with no explanation.
 *
 * Returns { ok: true, interests } or { ok: false, error }.
 * `error` is a translation key — the app renders it.
 */
export function sanitiseInterests(input) {
  if (!Array.isArray(input)) {
    return { ok: false, error: "interestsInvalid" };
  }

  // Deduplicate before counting, so picking the same one twice via a stale
  // client does not eat the allowance.
  const unique = [...new Set(input.map((v) => String(v).trim().toLowerCase()))];

  const unknown = unique.filter((v) => !INTEREST_SET.has(v));
  if (unknown.length) {
    return { ok: false, error: "interestsInvalid" };
  }

  if (unique.length > MAX_INTERESTS) {
    return { ok: false, error: "interestsMax" };
  }

  // Store in canonical order rather than tap order, so two users with the
  // same interests produce identical arrays — which makes any future
  // "shared interests" comparison a straight set intersection.
  return {
    ok: true,
    interests: INTERESTS.filter((id) => unique.includes(id)),
  };
}
