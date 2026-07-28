// localpulse/api/src/models/plugins/profileCompleteness.js
//
// Keeps the stored `profileComplete` boolean honest, and exposes the list of
// what is still missing.
//
// A completeness flag written once at signup goes stale the moment someone
// fills a gap later — and a stale flag is worse than none, because the app
// trusts it. This derives the value on every write path instead.
//
// Usage, in User.js AFTER the schema fields are defined:
//
//   import { profileCompleteness } from './plugins/profileCompleteness.js';
//   userSchema.plugin(profileCompleteness);
//
// `profileComplete` must already exist as a real Boolean path on the schema.
// Do NOT also declare it as a virtual — Mongoose throws on the collision.

// Single source of truth for what "complete" means. Add a requirement here
// and every code path picks it up.
//
// Each entry: the field name the API reports, and a test against the doc.
var REQUIREMENTS = [
  {
    field: "username",
    isPresent: (doc) => !!String(doc.username || "").trim(),
  },
  { field: "dateOfBirth", isPresent: (doc) => !!doc.dateOfBirth },
  { field: "gender", isPresent: (doc) => !!doc.gender },
  {
    field: "location",
    isPresent: (doc) =>
      Array.isArray(doc.location?.coordinates) &&
      doc.location.coordinates.length === 2,
  },
];

// Paths that, when touched by an update, mean completeness must be recomputed.
var WATCHED_PATHS = ["username", "dateOfBirth", "gender", "location"];

export function missingFieldsFor(doc) {
  if (!doc) return REQUIREMENTS.map((r) => r.field);
  return REQUIREMENTS.filter((r) => !r.isPresent(doc)).map((r) => r.field);
}

// Does this update touch anything relevant? Avoids a re-read on every
// unrelated write (last-seen timestamps, push tokens, and so on).
function updateTouchesWatched(update) {
  if (!update) return false;

  var keys = [];
  for (var operator of Object.keys(update)) {
    if (operator.startsWith("$"))
      keys.push(...Object.keys(update[operator] || {}));
    else keys.push(operator);
  }

  return keys.some((key) =>
    WATCHED_PATHS.some(
      (watched) => key === watched || key.startsWith(watched + "."),
    ),
  );
}

export function profileCompleteness(schema) {
  if (!schema.path("profileComplete")) {
    throw new Error(
      "profileCompleteness plugin: the schema needs a real `profileComplete` " +
        "Boolean path. Add it to the schema definition, and make sure it is " +
        "not also declared as a virtual.",
    );
  }

  schema.methods.missingProfileFields = function () {
    return missingFieldsFor(this);
  };

  // Convenience for controllers building a response.
  schema.methods.profileState = function () {
    var missing = missingFieldsFor(this);
    return {
      profileComplete: missing.length === 0,
      missingProfileFields: missing,
    };
  };

  schema.statics.missingProfileFieldsFor = missingFieldsFor;

  // Covers user.save() — including load-modify-save in controllers.
  schema.pre("save", function () {
    this.profileComplete = missingFieldsFor(this).length === 0;
  });

  // findOneAndUpdate / updateOne / updateMany bypass pre('save') entirely,
  // which is the usual way a flag like this drifts. Recompute afterwards
  // from the actual stored document.
  //
  // Done as a post hook with a re-read rather than trying to predict the
  // result of the update operators: an update can use $set, $unset, dotted
  // paths, or positional operators, and guessing the outcome is how you get
  // a flag that is right most of the time.
  async function recomputeAfterUpdate() {
    if (!updateTouchesWatched(this.getUpdate())) return;

    var filter = this.getFilter();
    var docs = await this.model
      .find(filter)
      .select([...WATCHED_PATHS, "profileComplete"].join(" "));

    for (var doc of docs) {
      var next = missingFieldsFor(doc).length === 0;
      if (doc.profileComplete !== next) {
        // updateOne here, not save(), to avoid re-triggering hooks.
        await this.model.updateOne({ _id: doc._id }, { profileComplete: next });
      }
    }
  }

  schema.post("findOneAndUpdate", recomputeAfterUpdate);
  schema.post("updateOne", recomputeAfterUpdate);
  schema.post("updateMany", recomputeAfterUpdate);

  // New users are almost never complete; make sure the default is not
  // silently `undefined`, which is falsy but reads badly in the API.
  schema.pre("validate", function () {
    if (this.profileComplete === undefined) this.profileComplete = false;
  });
}

export { REQUIREMENTS };
