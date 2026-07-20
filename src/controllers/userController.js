// localpulse/server/src/controllers/userController.js
import User, { coarseLocationName } from '../models/User.js';
import Follow from '../models/Follow.js';
import Post from '../models/Post.js';
import { notify } from '../lib/notify.js';

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
  return km < 1 ? Math.max(0.1, Math.round(km * 10) / 10) : Math.round(km * 10) / 10;
}

// local-pulse-api/src/controllers/userController.js
export async function getProfile(req, res) {
  try {
    const user = await User.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [followers, following, viewerFollows, posts] = await Promise.all([
      Follow.countDocuments({ following: user._id }),
      Follow.countDocuments({ follower: user._id }),
      req.userId
        ? Follow.exists({ follower: req.userId, following: user._id })
        : Promise.resolve(false),
      Post.find({ author: user._id }).sort({ createdAt: -1 }).limit(20).populate('author'),
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
      const me = await User.findById(req.userId).select('location browseLocation');
      const from = me?.browseLocation?.coordinates?.length === 2
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
    const locationName = (user.showDistance ?? true)
      ? coarseLocationName(user.locationName)
      : '';

    return res.json({
      profile: {
        ...user.toPublic(),
        gender: user.gender,
        age: user.dob ? Math.floor((Date.now() - new Date(user.dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : null,
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
    console.error('getProfile error', err);
    return res.status(500).json({ error: 'Could not load profile' });
  }
}

export async function follow(req, res) {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (String(target._id) === String(req.userId)) {
      return res.status(400).json({ error: "You can't follow yourself" });
    }
    await Follow.updateOne(
      { follower: req.userId, following: target._id },
      { $setOnInsert: { follower: req.userId, following: target._id } },
      { upsert: true }
    );
    await notify({
      userId: target._id,
      actorId: req.userId,
      type: 'follow',
      title: 'New follower',
      body: 'Someone started following you',
    });
    return res.json({ following: true });
  } catch (err) {
    console.error('follow error', err);
    return res.status(500).json({ error: 'Could not follow' });
  }
}

export async function unfollow(req, res) {
  try {
    await Follow.deleteOne({ follower: req.userId, following: req.params.id });
    return res.json({ following: false });
  } catch (err) {
    console.error('unfollow error', err);
    return res.status(500).json({ error: 'Could not unfollow' });
  }
}

// Feed of posts from people the viewer follows.
export async function followingFeed(req, res) {
  try {
    const { before, limit } = req.query;
    const lim = Math.min(Number(limit) || 20, 50);

    const edges = await Follow.find({ follower: req.userId }).select('following');
    const ids = edges.map((e) => e.following);

    const posts = await Post.find({
      author: { $in: ids },
      ...(before ? { createdAt: { $lt: new Date(before) } } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(lim)
      .populate('author');

    return res.json({ posts: posts.map((p) => p.toClient(req.userId)) });
  } catch (err) {
    console.error('followingFeed error', err);
    return res.status(500).json({ error: 'Could not load following feed' });
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
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (displayName != null) user.displayName = String(displayName).slice(0, 40);
    if (bio != null) user.bio = String(bio).slice(0, 300);

    // validateBeforeSave: legacy documents carry invalid enum values (notably
    // gender: 'man'), and Mongoose validates the WHOLE document on save. The
    // two fields written here are bounded above, so skip whole-doc validation
    // to avoid 500ing a name/bio edit on an unrelated legacy field.
    await user.save({ validateBeforeSave: false });
    return res.json({ user: user.toPublic() });
  } catch (err) {
    console.error('updateProfile error', err);
    return res.status(500).json({ error: 'Could not update profile' });
  }
}