// localpulse/server/scripts/patch-admin-retracted-route.cjs
//
// Mounts GET /admin/messages/retracted, backed by the new
// adminRetractedController.js.
//
// Gated with requireModerator, matching the other message surfaces: retraction
// is content, not an account action, and a moderator who cannot see a
// withdrawn message cannot act on a complaint about it.
//
// Placed next to /messages/hidden and /messages/removed. All three are literal
// segments and cannot be shadowed by /messages/:id/... , which has an extra
// segment after the parameter.
//
// Validates the output as an ES module before writing — a broken route file is
// an ESM load failure that takes down every endpoint, not just this one.
//
// Idempotent.
//
//   node scripts/patch-admin-retracted-route.cjs

var fs = require("fs");
var path = require("path");
var execFileSync = require("child_process").execFileSync;

var ROUTES = path.join(__dirname, "..", "src", "routes", "admin.routes.js");
var CONTROLLER = path.join(
  __dirname,
  "..",
  "src",
  "controllers",
  "adminRetractedController.js",
);

function fail(message) {
  console.error("ABORTED — " + message);
  console.error("No changes written.");
  process.exit(1);
}

if (!fs.existsSync(ROUTES)) fail("file not found: " + ROUTES);
if (!fs.existsSync(CONTROLLER)) {
  fail(
    "adminRetractedController.js is not installed yet.\n" +
      "  Save it to src/controllers/ first — importing a file that does not\n" +
      "  exist is an ESM load failure that takes the whole API down.",
  );
}

var src = fs.readFileSync(ROUTES, "utf8");

if (src.indexOf('"/messages/retracted"') !== -1) {
  console.log("No changes — the retracted route is already mounted.");
  process.exit(0);
}

var applied = [];

// ── Edit 1: import the controller ────────────────────────
//
// Its own import statement rather than appending to the adminController list,
// so this cannot disturb a block other patches also edit.

var IMPORT_ANCHOR =
  'import { requireModerator } from "../middleware/requireModerator.js";';

if (src.indexOf(IMPORT_ANCHOR) === -1) {
  fail(
    "could not find the requireModerator import to anchor to. Expected:\n" +
      "    " + IMPORT_ANCHOR,
  );
}

src = src.replace(
  IMPORT_ANCHOR,
  'import { adminListRetractedMessages } from "../controllers/adminRetractedController.js";\n' +
    IMPORT_ANCHOR,
);
applied.push("import");

// ── Edit 2: mount the route ──────────────────────────────
//
// Anchored on the hidden-messages mount, which is the closest sibling. Matched
// loosely on the path string so reformatting does not break it.

var HIDDEN = /(router\.get\(\s*\n?\s*["']\/messages\/hidden["'][\s\S]{0,200}?\);\n)/;

var ADDITION =
  "\n" +
  "// Messages a SENDER withdrew. Retraction is irreversible and there is no\n" +
  "// restore here by design — this exists so a moderator can still read what\n" +
  "// was said when a complaint arrives after the fact. retractMessage refuses\n" +
  "// once a Report exists, so a row flagged BOTH retracted and reported means\n" +
  "// the report came second, and the thread will not contain the text.\n" +
  "router.get(\n" +
  '  "/messages/retracted",\n' +
  "  requireAuth,\n" +
  "  requireModerator,\n" +
  "  adminListRetractedMessages,\n" +
  ");\n";

if (!HIDDEN.test(src)) {
  fail(
    'could not find the "/messages/hidden" mount to anchor to.\n' +
      "  Add the route by hand next to it:\n" +
      '    router.get("/messages/retracted", requireAuth, requireModerator, adminListRetractedMessages);',
  );
}

src = src.replace(HIDDEN, "$1" + ADDITION);
applied.push("route");

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

fs.writeFileSync(ROUTES, src, "utf8");

console.log("Patched " + ROUTES);
console.log("  applied: " + applied.join(", "));
console.log("");
console.log("  GET /admin/messages/retracted  (requireModerator)");
console.log("  Output was parsed as ESM before writing. Restart the API.");
