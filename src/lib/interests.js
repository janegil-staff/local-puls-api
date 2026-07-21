// localpulse/server/src/lib/interestMap.js
//
// Maps a post's `type` to the interest values it implies, so the feed can
// boost posts matching the viewer's interests WITHOUT any mobile change.
// When posts later carry real `interests` tags from the mobile composer,
// interestsForPost() prefers those and this map becomes the fallback.
//
// Post types (from Post.js POST_TYPES):
//   update, event, recommendation, lostfound, marketplace, question
//
// The right-hand interest values MUST match src/lib/interests.js exactly.
// Adjust once you paste your real interest list — any value not in that
// list simply never matches (harmless, just inert).

export const TYPE_TO_INTERESTS = {
    update: [],                                  // generic, no strong signal
    event: ['events', 'music', 'nightlife'],
    recommendation: ['food', 'coffee', 'shopping'],
    lostfound: [],
    marketplace: ['shopping'],
    question: [],
};

/**
 * Interest values implied by a post.
 * Prefers real post.interests tags if present (future mobile build),
 * otherwise falls back to the type mapping.
 */
export function interestsForPost(post) {
    if (Array.isArray(post.interests) && post.interests.length > 0) {
        return post.interests;
    }
    return TYPE_TO_INTERESTS[post.type] || [];
}

/**
 * How many of the viewer's interests a post matches — the boost score.
 */
export function interestMatchScore(post, viewerInterests) {
    if (!Array.isArray(viewerInterests) || viewerInterests.length === 0) return 0;
    const postInterests = interestsForPost(post);
    if (postInterests.length === 0) return 0;
    const set = new Set(viewerInterests);
    let score = 0;
    for (const i of postInterests) {
        if (set.has(i)) score += 1;
    }
    return score;
}