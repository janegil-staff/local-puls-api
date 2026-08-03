// localpulse/server/src/controllers/adminRolesController.js
//
// Role management. Deliberately NOT in adminController.js — that file already
// shipped a duplicate export that made the whole module fail to parse, and
// still has missing imports. A privileged endpoint does not belong in a file
// with a known parse history.
//
// Every handler here runs behind requireAuth + requireAdmin. requireAdmin
// reads role from the database on each request (it does not trust the JWT,
// which carries only `sub`), so a demotion takes effect on the target's very
// next request. No token revocation needed.

import mongoose from "mongoose";
import User from "../models/User.js";
import RoleChange from "../models/RoleChange.js";

export const ASSIGNABLE_ROLES = ["user", "moderator", "admin"];

// PATCH /admin/users/:id/role   body: { role }
export async function setUserRole(req, res) {
  try {
    const { id } = req.params;
    const { role } = req.body || {};

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    // An admin cannot change their own role. This is not politeness — it is
    // the difference between one compromised admin account and a compromised
    // panel. Self-promotion is impossible anyway (they are already admin), so
    // in practice this blocks self-demotion, which is the lockout case.
    if (String(id) === String(req.userId)) {
      return res.status(403).json({
        error: "Cannot change your own role",
        code: "self_role_change",
      });
    }

    const target = await User.findById(id).select("role username");
    if (!target) {
      return res.status(404).json({ error: "User not found" });
    }

    const fromRole = target.role;

    // No-op. Return success without writing an audit entry — a log full of
    // "admin -> admin" makes the real changes harder to find.
    if (fromRole === role) {
      return res.json({ id: target._id, username: target.username, role });
    }

    // Never leave the system with zero admins. Without this, one click locks
    // everyone out of the panel and the only way back in is a mongo shell.
    if (fromRole === "admin" && role !== "admin") {
      const adminCount = await User.countDocuments({ role: "admin" });
      if (adminCount <= 1) {
        return res
          .status(409)
          .json({ error: "Cannot demote the last admin", code: "last_admin" });
      }
    }

    // findOneAndUpdate, NOT target.save().
    //
    // User.js has a pre('save') hook calling missingProfileFields(), which
    // reads this.dateOfBirth — a field that does not exist on the schema (it
    // is `dob`). The hook therefore always finds a missing field and sets
    // profileComplete = false on every save. Saving here would silently drop
    // the target out of discovery as a side effect of a role change.
    //
    // The filter re-checks role so two concurrent requests can't both pass the
    // last-admin guard and both demote.
    const updated = await User.findOneAndUpdate(
      { _id: id, role: fromRole },
      { $set: { role } },
      { new: true },
    ).select("role username");

    if (!updated) {
      return res.status(409).json({
        error: "Role changed concurrently, retry",
        code: "role_conflict",
      });
    }

    // Audit last, and never let a logging failure hide a successful change —
    // but do surface it, because a silent gap in the audit trail is worse than
    // a noisy one.
    try {
      await RoleChange.create({
        actor: req.userId,
        actorUsername: req.user?.username || "unknown",
        target: updated._id,
        targetUsername: updated.username,
        fromRole,
        toRole: role,
      });
    } catch (logErr) {
      console.error("setUserRole: audit write failed", logErr);
    }

    return res.json({
      id: updated._id,
      username: updated.username,
      role: updated.role,
      fromRole,
    });
  } catch (err) {
    console.error("setUserRole error", err);
    return res.status(500).json({ error: "Could not update role" });
  }
}

// GET /admin/users/:id/role-history
export async function listRoleChanges(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    const lim = Math.min(Number(req.query.limit) || 50, 100);
    const changes = await RoleChange.find({ target: id })
      .sort({ createdAt: -1 })
      .limit(lim);
    return res.json({ changes: changes.map((c) => c.toClient()) });
  } catch (err) {
    console.error("listRoleChanges error", err);
    return res.status(500).json({ error: "Could not load role history" });
  }
}

// GET /admin/role-changes  — the whole log, newest first.
export async function listAllRoleChanges(req, res) {
  try {
    const lim = Math.min(Number(req.query.limit) || 50, 100);
    const changes = await RoleChange.find().sort({ createdAt: -1 }).limit(lim);
    return res.json({ changes: changes.map((c) => c.toClient()) });
  } catch (err) {
    console.error("listAllRoleChanges error", err);
    return res.status(500).json({ error: "Could not load role changes" });
  }
}
