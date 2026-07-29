// localpulse/server/src/controllers/userController.js
import User, { coarseLocationName } from "../models/User.js";
import Follow from "../models/Follow.js";
import Post from "../models/Post.js";
import { notify } from "../lib/notify.js";

// Great-circle distance in km between two GeoJSON [lng, lat] pairs.
// Rounded to one decimal with a 0.1 floor, matching discoveryController's
// displayKm() so the same pair of users never disagrees between screens.
// Coordinates are already snapped to a ~100m grid on write (see
// locationController.snapCoords), which is what actually protects against
// trilateration; this rounding is cosmetic.
function haversineKm([lng1, lat1], [lng2, lat2]) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(h));
  return km < 1
    ? Math.max(0.1, Math.round(km * 10) / 10)
    : Math.round(km * 10) / 10;
}

// Whole years, by calendar.
//
// NOT elapsed-milliseconds / 365.25: that drifts by a day or two depending on
// where leap years fall, so the same person reads as 24 here and 25 in a screen
// that computed it differently. Someone whose birthday is today comes out a
// year young under the division — on an 18+ gate that is the wrong direction.
//
// The model's ageFromDob still uses the division. Worth aligning, but it feeds
// toPublic() which is used everywhere, so that is a separate edit.
function ageFrom(dob, now = new Date()) {
  if (!dob) return null;
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;

  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - birth.getUTCMonth();
  const dayDiff = now.getUTCDate() - birth.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age -= 1;

  return age;
}

// Pushes a live follower count to the person being followed.
//
// notify() sends a PUSH NOTIFICATION — it does not touch an app that is
// already open. Without this emit, someone looking at their own profile when
// a follow lands sees the number change only on the next pull-to-refresh,
// which reads as the app being stale rather than live.
//
// Fire-and-forget by design: the count is also returned by the HTTP response
// and recomputed on every profile load, so a missed emit self-corrects. The
// target being offline is the normal case, not an error.
function emitFollowerCount(req, targetId, followerCount) {
  const io = req.app.get("io");
  if (!io) return;

  io.to(`user:${targetId}`).emit("profile:followers", {
    userId: String(targetId),
    followerCount,
  });
}

export async function getProfile(req, res) {
  try {
    const user = await User.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: "User not found" });

    const [followers, following, viewerFollows, posts] = await Promise.all([
      Follow.countDocuments({ following: user._id }),
      Follow.countDocuments({ follower: user._id }),
      req.userId
        ? Follow.exists({ follower: req.userId, following: user._id })
        : Promise.resolve(false),
      Post.find({ author: user._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .populate("author"),
    ]);

    // Distance from the viewer, measured the same way Discover measures it:
    // from the viewer's BROWSE location if they've set one, else their real
    // location. Tapping a card that says "~2 km" must not open a profile that
    // says "460 km" because the viewer is browsing another city.
    //
    // Gated on the target's showDistance flag — the same privacy rule
    // discoveryController honours. Without this check the profile page is a
    // way around a setting the user deliberately turned off.
    //
    // Null (not 0) when unavailable: either party lacking coordinates, the
    // viewer being logged out, or the target hiding distance. The client omits
    // the row rather than printing "0 km".
    let distanceKm = null;
    if (req.userId && (user.showDistance ?? true)) {
      const me = await User.findById(req.userId).select(
        "location browseLocation",
      );
      const from =
        me?.browseLocation?.coordinates?.length === 2
          ? me.browseLocation.coordinates
          : me?.location?.coordinates;
      const to = user.location?.coordinates;
      if (from?.length === 2 && to?.length === 2) {
        distanceKm = haversineKm(from, to);
      }
    }

    // Coarsened, gated location label. toPublic() deliberately no longer carries
    // locationName because the raw value ("Bergen sentrum", "Majorstuen, Oslo")
    // is granular and ungated. Here we:
    //   1. gate it behind the same showDistance flag as distanceKm — a user who
    //      hides distance should not have their town handed out instead, and
    //   2. coarsen it to the broadest segment (city/region) via
    //      coarseLocationName.
    // Empty string when hidden or absent; the client drops the fact.
    const locationName =
      (user.showDistance ?? true) ? coarseLocationName(user.locationName) : "";

    return res.json({
      profile: {
        ...user.toPublic(),
        gender: user.gender,
        age: ageFrom(user.dob),
        language: user.language,
        locationName,
        distanceKm,
        followerCount: followers,
        followingCount: following,
        followedByMe: Boolean(viewerFollows),
      },
      posts: posts.map((p) => p.toClient(req.userId)),
    });
  } catch (err) {
    console.error("getProfile error", err);
    return res.status(500).json({ error: "Could not load profile" });
  }
}

// ── Follower / following lists ────────────────────────────────────────
//
// Both behind requireAuth. A follower list on a proximity app is a social
// graph tied to physical location — who this person knows, near where they
// live — so it is not something to hand out to anyone with the URL.
//
// If these should be private to the profile owner rather than visible to any
// signed-in user, add:
//
//   if (String(req.userId) !== String(req.params.id)) return res.status(403)...
//
// Each row carries followedByMe so the list can render its own Follow buttons
// without a request per row.
async function followList(req, res, { direction }) {
  const { before, limit } = req.query;
  const lim = Math.min(Number(limit) || 30, 100);

  // 'followers' -> people following :id
  // 'following' -> people :id follows
  const match =
    direction === "followers"
      ? { following: req.params.id }
      : { follower: req.params.id };

  // Cursor on createdAt rather than skip/limit: skip degrades on large lists
  // and shifts rows under the user when someone follows mid-scroll.
  const edges = await Follow.find({
    ...match,
    ...(before ? { createdAt: { $lt: new Date(before) } } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(lim)
    .populate(direction === "followers" ? "follower" : "following");

  const users = edges
    .map((e) => (direction === "followers" ? e.follower : e.following))
    .filter(Boolean);

  // One query for the viewer's own edges rather than one per row.
  const ids = users.map((u) => u._id);
  const mine = req.userId
    ? await Follow.find({
        follower: req.userId,
        following: { $in: ids },
      }).select("following")
    : [];
  const followedByMe = new Set(mine.map((e) => String(e.following)));

  return res.json({
    users: users.map((u) => ({
      // toPublic() is the right serializer: it already excludes email, dob and
      // the raw location, so a follower list cannot become a way to harvest
      // them in bulk.
      ...u.toPublic(),
      followedByMe: followedByMe.has(String(u._id)),
      // Lets the list hide the follow button on your own row rather than
      // showing one the server will reject.
      isSelf: String(u._id) === String(req.userId),
    })),
    // Cursor for the next page. Null when this page was not full, so the
    // client knows to stop.
    nextBefore:
      edges.length === lim
        ? edges[edges.length - 1].createdAt.toISOString()
        : null,
  });
}

export async function listFollowers(req, res) {
  try {
    return await followList(req, res, { direction: "followers" });
  } catch (err) {
    console.error("listFollowers error", err);
    return res.status(500).json({ error: "Could not load followers" });
  }
}

export async function listFollowing(req, res) {
  try {
    return await followList(req, res, { direction: "following" });
  } catch (err) {
    console.error("listFollowing error", err);
    return res.status(500).json({ error: "Could not load following" });
  }
}

export async function follow(req, res) {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: "User not found" });
    if (String(target._id) === String(req.userId)) {
      return res.status(400).json({ error: "You can't follow yourself" });
    }

    // upsert + $setOnInsert makes this idempotent: a double-tap, or the app
    // retrying after a dropped response, cannot create a second edge or send
    // a second notification for the same follow.
    const result = await Follow.updateOne(
      { follower: req.userId, following: target._id },
      { $setOnInsert: { follower: req.userId, following: target._id } },
      { upsert: true },
    );

    const isNew = result.upsertedCount > 0;

    const followerCount = await Follow.countDocuments({
      following: target._id,
    });

    // Only notify on a NEW edge. Without this check, re-following someone you
    // already follow pings them again — a nuisance the follower cannot see and
    // would never intend.
    if (isNew) {
      await notify({
        userId: target._id,
        actorId: req.userId,
        type: "follow",
        title: "New follower",
        body: "Someone started following you",
      });

      emitFollowerCount(req, target._id, followerCount);
    }

    // Count returned so the client can reconcile its optimistic value against
    // the truth without a second request.
    return res.json({ following: true, followerCount });
  } catch (err) {
    console.error("follow error", err);
    return res.status(500).json({ error: "Could not follow" });
  }
}

export async function unfollow(req, res) {
  try {
    const result = await Follow.deleteOne({
      follower: req.userId,
      following: req.params.id,
    });

    const followerCount = await Follow.countDocuments({
      following: req.params.id,
    });

    // Only when an edge was actually removed. Unfollowing someone you were not
    // following is a no-op, and emitting anyway would push a redundant update
    // to a device that is already correct.
    if (result.deletedCount > 0) {
      emitFollowerCount(req, req.params.id, followerCount);
    }

    return res.json({ following: false, followerCount });
  } catch (err) {
    console.error("unfollow error", err);
    return res.status(500).json({ error: "Could not unfollow" });
  }
}

// Feed of posts from people the viewer follows.
export async function followingFeed(req, res) {
  try {
    const { before, limit } = req.query;
    const lim = Math.min(Number(limit) || 20, 50);

    const edges = await Follow.find({ follower: req.userId }).select(
      "following",
    );
    const ids = edges.map((e) => e.following);

    const posts = await Post.find({
      author: { $in: ids },
      ...(before ? { createdAt: { $lt: new Date(before) } } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(lim)
      .populate("author");

    return res.json({ posts: posts.map((p) => p.toClient(req.userId)) });
  } catch (err) {
    console.error("followingFeed error", err);
    return res.status(500).json({ error: "Could not load following feed" });
  }
}

// Lightweight profile update path used by this router. The full dating-profile
// editor (photos, dob, gender, language, privacy flags, username/email with PIN)
// lives in profileController.updateProfile; this one handles only the small set
// of fields the public-app profile edit sends: displayName and bio.
//
// Deliberately narrow: the previous version referenced an undefined `normalized`
// and wrote a non-schema `avatarUrl`, both of which would throw. Email changes
// are a login-credential operation and must go through profileController, which
// validates format, checks the PIN, and enforces uniqueness — so email is
// ignored here rather than half-handled.
export async function updateProfile(req, res) {
  try {
    const { displayName, bio } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (displayName != null)
      user.displayName = String(displayName).slice(0, 40);
    if (bio != null) user.bio = String(bio).slice(0, 300);

    // validateBeforeSave: legacy documents carry invalid enum values (notably
    // gender: 'man'), and Mongoose validates the WHOLE document on save. The
    // two fields written here are bounded above, so skip whole-doc validation
    // to avoid 500ing a name/bio edit on an unrelated legacy field.
    await user.save({ validateBeforeSave: false });
    return res.json({ user: user.toPublic() });
  } catch (err) {
    console.error("updateProfile error", err);
    return res.status(500).json({ error: "Could not update profile" });
  }
}
