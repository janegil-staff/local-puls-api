// localpulse/server/scripts/patch-user-dob-field.cjs
//
// Fixes: nobody appears in discovery after saving their profile.
//
// missingProfileFields() checks `this.dateOfBirth`. That field does not exist
// on this schema — it is `dob`, declared under Profile with a default of 25
// years ago. So the check is always falsy, "dateOfBirth" is always in the
// missing list, and the pre-save hook sets profileComplete = false on EVERY
// user on EVERY save.
//
// Blast radius is everything that writes a user document: editing a profile,
// uploading a photo, changing a setting, updating a location, the presence
// heartbeat if it saves. Discovery filters on profileComplete, so a user
// disappears from it the first time anything touches their record — including
// a save they never knew happened.
//
// The reported string stays "dateOfBirth" rather than becoming "dob": it is
// user-facing, appearing in onboarding as the name of the thing that is
// missing, and "dob" is not a word. Only the property read changes.
//
// WORTH KNOWING, not fixed here. `dob` carries a schema default, so it is
// never absent and this check can now never fail. That makes it dead weight in
// the completeness list rather than a real gate — arguably fine, since the
// default exists precisely so age is always computable, but if date of birth
// is meant to be something the user actually supplies, the default is the
// thing to reconsider, not this line.
//
// ALSO: there is a profileCompleteness plugin registered on this schema
// (userSchema.plugin(profileCompleteness)) as well as this hook. Two things
// deriving the same flag is how they come to disagree. Worth checking which
// one wins.
//
// Idempotent. Validates the output as an ES module before writing.
//
//   node scripts/patch-user-dob-field.cjs

var fs = require("fs");
var path = require("path");
var execFileSync = require("child_process").execFileSync;

var FILE = path.join(__dirname, "..", "src", "models", "User.js");

function fail(message) {
  console.error("ABORTED — " + message);
  console.error("No changes written.");
  process.exit(1);
}

if (!fs.existsSync(FILE)) fail("file not found: " + FILE);

var src = fs.readFileSync(FILE, "utf8");
var applied = [];

if (src.indexOf("!this.dateOfBirth") === -1) {
  if (/if \(!this\.dob\) missing\.push\("dateOfBirth"\);/.test(src)) {
    console.log("No changes — the check already reads this.dob.");
    process.exit(0);
  }
  fail(
    "could not find `if (!this.dateOfBirth) missing.push(\"dateOfBirth\");`\n" +
      "  in missingProfileFields(). Check it by hand.",
  );
}

// ── Edit 1: the field read ───────────────────────────────

var CHECK = /( *)if \(!this\.dateOfBirth\) missing\.push\("dateOfBirth"\);/;

src = src.replace(CHECK, function (whole, indent) {
  return (
    indent +
    "// `dob`, not `dateOfBirth` — the schema field is dob. Reading the wrong\n" +
    indent +
    "// name was always falsy, so profileComplete was set to false on every\n" +
    indent +
    "// save and every user dropped out of discovery. The reported STRING\n" +
    indent +
    "// stays dateOfBirth: it is shown to the user during onboarding.\n" +
    indent +
    'if (!this.dob) missing.push("dateOfBirth");'
  );
});
applied.push("this.dateOfBirth -> this.dob");

// ── Edit 2: the stray filepath comment ───────────────────
//
// A second, different filepath header sits in the middle of the file
// (localpulse/api/... vs localpulse/server/... at the top). Two paths claiming
// to be the same file is a small thing that makes grep results lie.

var STRAY = /\n\/\/ localpulse\/api\/src\/models\/User\.js\n/;
if (STRAY.test(src)) {
  src = src.replace(STRAY, "\n");
  applied.push("stray mid-file filepath comment removed");
}

// ── Validate before writing ──────────────────────────────

try {
  execFileSync("node", ["--input-type=module", "--check"], {
    input: src,
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch (err) {
  fail(
    "the patched output does not parse as an ES module, so it was NOT\n" +
      "  written. Your file is untouched. Parser said:\n\n" +
      String(err.stderr || err.message)
        .split("\n")
        .slice(0, 8)
        .map(function (row) {
          return "    " + row;
        })
        .join("\n"),
  );
}

fs.writeFileSync(FILE, src, "utf8");

console.log("Patched " + FILE);
applied.forEach(function (row) {
  console.log("  " + row);
});
console.log("");
console.log("  Output was parsed as ESM before writing. Restart the API.");
console.log("");
console.log("  EXISTING USERS ARE STILL FLAGGED INCOMPLETE — the flag is only");
console.log("  recomputed on save, so anyone marked false stays false until");
console.log("  their document is written again. To repair them now:");
console.log("");
console.log("    db.users.updateMany(");
console.log("      { location: { $exists: true }, gender: { $exists: true } },");
console.log("      { $set: { profileComplete: true } }");
console.log("    )");
console.log("");
console.log("  Check that filter against your own data before running it.");
