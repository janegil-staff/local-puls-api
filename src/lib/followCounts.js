// localpulse/server/src/lib/followCounts.js
//
// Follow counts, resolved at runtime against whichever storage this project
// actually uses.
//
// Two shapes exist in the wild and this codebase has carried both at different
// points: a separate Follow collection (one document per edge), or arrays on the
// User document. Hard-coding either means the counts silently read 0 on the
// other — which is exactly the bug this file exists to end.
//
// Detection runs once and is cached. If neither shape is present it warns once
// and returns zeros rather than throwing: a profile page missing a number is a
// smaller failure than a profile page that will not load.

import mongoose from "mongoose";

// Candidate field names on a Follow document, in priority order. The first pair
// whose paths both exist on the schema wins.
const EDGE_FIELD_PAIRS = [
  { follower: "follower", following: "following" },
  { follower: "from", following: "to" },
  { follower: "user", following: "target" },
  { follower: "followerId", following: "followingId" },
];

// Candidate array fields on a User document.
const USER_ARRAY_FIELDS = {
  followers: ["followers", "followedBy"],
  following: ["following", "follows"],
};

let strategy;

function resolveStrategy() {
  if (strategy !== undefined) return strategy;

  // 1. A Follow collection, if the model is registered.
  let Follow = null;
  try {
    Follow = mongoose.model("Follow");
  } catch {
    Follow = null;
  }

  if (Follow) {
    const pair = EDGE_FIELD_PAIRS.find(
      (candidate) =>
        Follow.schema.path(candidate.follower) &&
        Follow.schema.path(candidate.following),
    );

    if (pair) {
      strategy = { kind: "collection", Follow, ...pair };
      return strategy;
    }

    console.warn(
      "[followCounts] Follow model found but no known field pair matched. " +
        `Tried: ${EDGE_FIELD_PAIRS.map((p) => `${p.follower}/${p.following}`).join(", ")}`,
    );
  }

  // 2. Arrays on the User document.
  let User = null;
  try {
    User = mongoose.model("User");
  } catch {
    User = null;
  }

  if (User) {
    const followersField = USER_ARRAY_FIELDS.followers.find((name) =>
      User.schema.path(name),
    );
    const followingField = USER_ARRAY_FIELDS.following.find((name) =>
      User.schema.path(name),
    );

    if (followersField || followingField) {
      strategy = { kind: "arrays", User, followersField, followingField };
      return strategy;
    }
  }

  console.warn(
    "[followCounts] No follow storage detected — counts will read 0. " +
      "Register a Follow model or add followers/following arrays to User.",
  );
  strategy = { kind: "none" };
  return strategy;
}

// Counts for one user. Returns { followersCount, followingCount }.
export async function getFollowCounts(userId) {
  const resolved = resolveStrategy();
  if (resolved.kind === "none" || !userId) {
    return { followersCount: 0, followingCount: 0 };
  }

  if (resolved.kind === "collection") {
    const { Follow, follower, following } = resolved;

    // followers = edges pointing AT this user; following = edges FROM them.
    const [followersCount, followingCount] = await Promise.all([
      Follow.countDocuments({ [following]: userId }),
      Follow.countDocuments({ [follower]: userId }),
    ]);

    return { followersCount, followingCount };
  }

  const { User, followersField, followingField } = resolved;

  const projection = {};
  if (followersField) projection[followersField] = 1;
  if (followingField) projection[followingField] = 1;

  const user = await User.findById(userId, projection).lean();
  if (!user) return { followersCount: 0, followingCount: 0 };

  return {
    followersCount: followersField ? (user[followersField]?.length ?? 0) : 0,
    followingCount: followingField ? (user[followingField]?.length ?? 0) : 0,
  };
}

// Counts for many users at once, as a Map keyed by string id. Use this in list
// endpoints rather than calling getFollowCounts per row — N users would
// otherwise mean 2N queries.
export async function getFollowCountsMap(userIds) {
  const result = new Map();
  const ids = [...new Set((userIds || []).map(String))];
  if (ids.length === 0) return result;

  const resolved = resolveStrategy();
  for (const id of ids)
    result.set(id, { followersCount: 0, followingCount: 0 });
  if (resolved.kind === "none") return result;

  if (resolved.kind === "collection") {
    const { Follow, follower, following } = resolved;
    const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));

    const [followerGroups, followingGroups] = await Promise.all([
      Follow.aggregate([
        { $match: { [following]: { $in: objectIds } } },
        { $group: { _id: `$${following}`, count: { $sum: 1 } } },
      ]),
      Follow.aggregate([
        { $match: { [follower]: { $in: objectIds } } },
        { $group: { _id: `$${follower}`, count: { $sum: 1 } } },
      ]),
    ]);

    for (const row of followerGroups) {
      const entry = result.get(String(row._id));
      if (entry) entry.followersCount = row.count;
    }
    for (const row of followingGroups) {
      const entry = result.get(String(row._id));
      if (entry) entry.followingCount = row.count;
    }

    return result;
  }

  const { User, followersField, followingField } = resolved;
  const projection = {};
  if (followersField) projection[followersField] = 1;
  if (followingField) projection[followingField] = 1;

  const users = await User.find({ _id: { $in: ids } }, projection).lean();
  for (const user of users) {
    result.set(String(user._id), {
      followersCount: followersField ? (user[followersField]?.length ?? 0) : 0,
      followingCount: followingField ? (user[followingField]?.length ?? 0) : 0,
    });
  }

  return result;
}

// Convenience: merge counts onto a plain object produced by toSelf()/toPublic().
export async function withFollowCounts(payload, userId) {
  const counts = await getFollowCounts(userId);
  return { ...payload, ...counts };
}

// Exposed for tests and for logging which path was taken at boot.
export function describeFollowStorage() {
  const resolved = resolveStrategy();
  if (resolved.kind === "collection") {
    return `Follow collection (${resolved.follower} -> ${resolved.following})`;
  }
  if (resolved.kind === "arrays") {
    return `User arrays (${resolved.followersField ?? "—"} / ${resolved.followingField ?? "—"})`;
  }
  return "none detected";
}
