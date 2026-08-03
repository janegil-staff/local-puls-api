// localpulse/server/src/models/RoleChange.js
//
// Append-only audit trail for role changes.
//
// Nothing in the app deletes from this collection, and nothing should. A role
// change is the highest-privilege action the panel offers; the question "who
// made this person an admin, and when" needs an answer that does not depend on
// anyone remembering.
//
// Stores the role on BOTH sides of the change. Deriving the previous role by
// walking backwards through the log breaks the moment a change is written by
// anything other than adminRolesController.

import mongoose from "mongoose";

const roleChangeSchema = new mongoose.Schema(
  {
    // Who made the change. Never null — the endpoint requires an authenticated
    // admin, so an entry without an actor would mean something wrote here
    // outside the controller.
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    actorUsername: { type: String, required: true },

    target: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    targetUsername: { type: String, required: true },

    fromRole: { type: String, required: true },
    toRole: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Usernames are denormalized on purpose. A ref alone gives you a useless log
// once an account is deleted, and account deletion is a compliance surface
// this app already supports.

roleChangeSchema.index({ createdAt: -1 });

roleChangeSchema.methods.toClient = function toClient() {
  return {
    id: this._id,
    actor: { id: this.actor, username: this.actorUsername },
    target: { id: this.target, username: this.targetUsername },
    fromRole: this.fromRole,
    toRole: this.toRole,
    createdAt: this.createdAt,
  };
};

export default mongoose.model("RoleChange", roleChangeSchema);
