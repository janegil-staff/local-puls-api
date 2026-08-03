// localpulse/server/src/middleware/requireModerator.js
//
// Runs after requireAuth. Allows admin OR moderator, and stashes the role on
// req so controllers can vary their response by role (e.g. omitting PII for
// moderators).
//
// Deliberately a separate middleware rather than a parameter on requireAdmin:
// a route's guard should be readable at the mount point without following an
// argument, since that line is the whole access-control story for the route.
//
// Also checks `banned`, which requireAdmin selects but never tests — a banned
// admin currently keeps full panel access. Fixed here and worth fixing there.

import User from "../models/User.js";

export const STAFF_ROLES = ["admin", "moderator"];

export async function requireModerator(req, res, next) {
  try {
    const user = await User.findById(req.userId).select("role banned");
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    req.userRole = user.role;

    if (user.banned) {
      return res.status(403).json({ error: "Account suspended" });
    }
    if (!STAFF_ROLES.includes(user.role)) {
      return res.status(403).json({ error: "Moderator access required" });
    }
    return next();
  } catch {
    return res.status(500).json({ error: "Authorization check failed" });
  }
}
