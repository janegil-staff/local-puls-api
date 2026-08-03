// localpulse/server/scripts/patch-chat-routes-retract2.cjs
//
// Fixes: "Route not found: POST /api/chat/messages/:id/retract"
//
// REPLACES patch-chat-routes-retract.cjs, which was wrong. That script only
// uncommented lines. The mount line for retract IS commented out — but
// retractMessage and unhideMessage are NOT in the chatController import list
// at all, not even commented. Uncommenting the route alone would have thrown
// ReferenceError: retractMessage is not defined at module load and taken every
// chat endpoint down, rather than 404ing one. Delete that script.
//
// WHAT THIS DOES
//   1. adds retractMessage and unhideMessage to the chatController import
//   2. uncomments the retract mount line, and removes the "re-enable once
//      retractMessage exists" note above it, which is now false
//   3. adds an unhide mount line next to hide — unhide has no route at all,
//      only prose describing one, so there is nothing to uncomment
//
// The explanatory comment block about hide / retract / report is left exactly
// as it is. It is prose, it is correct, and it is the reason this file is
// readable.
//
// Idempotent. Aborts without writing if the controller does not export both
// handlers, because adding the import then is the same crash by another route.
//
//   node scripts/patch-chat-routes-retract2.cjs
//   node --check src/routes/chat.routes.js

var fs = require("fs");
var path = require("path");

var ROUTES = path.join(__dirname, "..", "src", "routes", "chat.routes.js");
var CONTROLLER = path.join(
  __dirname,
  "..",
  "src",
  "controllers",
  "chatController.js",
);

var NAMES = ["unhideMessage", "retractMessage"];

function fail(message) {
  console.error("ABORTED — " + message);
  console.error("No changes written.");
  process.exit(1);
}

if (!fs.existsSync(ROUTES)) fail("file not found: " + ROUTES);
if (!fs.existsSync(CONTROLLER)) fail("file not found: " + CONTROLLER);

// ── Guard ────────────────────────────────────────────────

var controller = fs.readFileSync(CONTROLLER, "utf8");
var missing = NAMES.filter(function (name) {
  return (
    controller.indexOf("export async function " + name) === -1 &&
    controller.indexOf("export function " + name) === -1
  );
});

if (missing.length > 0) {
  fail(
    "chatController.js does not export: " +
      missing.join(", ") +
      "\n  Run patch-chat-retraction.cjs first.",
  );
}

var src = fs.readFileSync(ROUTES, "utf8");
var applied = [];

// ── Edit 1: the import list ──────────────────────────────
//
// Matched on the source path rather than on the names inside, so reordering or
// reformatting the block does not break this.

// [^}]* rather than [\s\S]*? — a lazy any-character match starts at the FIRST
// `import {` in the file and happily spans the express import to reach
// chatController.js, swallowing both blocks into one. Import lists never
// contain a closing brace, so excluding it confines the match to a single
// statement.
var IMPORT = /import\s*\{([^}]*)\}\s*from\s*(["'])(\.\.\/controllers\/chatController\.js)\2/;

var importMatch = src.match(IMPORT);
if (!importMatch) {
  fail(
    "could not find the chatController.js import block in chat.routes.js.",
  );
}

var names = importMatch[1]
  .split(",")
  .map(function (name) {
    return name.trim();
  })
  .filter(Boolean);

var added = [];
NAMES.forEach(function (name) {
  if (names.indexOf(name) === -1) {
    names.push(name);
    added.push(name);
  }
});

if (added.length > 0) {
  var rebuilt =
    "import {\n  " +
    names.join(",\n  ") +
    ",\n} from " +
    importMatch[2] +
    importMatch[3] +
    importMatch[2];
  src = src.replace(importMatch[0], rebuilt);
  applied.push("import (" + added.join(", ") + ")");
}

// ── Edit 2: uncomment the retract mount ──────────────────

var COMMENTED_RETRACT =
  /^([ \t]*)\/\/\s?(router\.post\(\s*["']\/messages\/:id\/retract["'][^\n]*)$/m;

if (/^[ \t]*router\.post\(\s*["']\/messages\/:id\/retract["']/m.test(src)) {
  // already active
} else if (COMMENTED_RETRACT.test(src)) {
  src = src.replace(COMMENTED_RETRACT, "$1$2");
  applied.push("retract route uncommented");

  // The note above it said to re-enable once the handler exists. It does now.
  var STALE_NOTE =
    /[ \t]*\/\/ Re-enable once retractMessage exists in chatController\.js\. The web client\n[ \t]*\/\/ already calls this endpoint\.\n/;
  if (STALE_NOTE.test(src)) {
    src = src.replace(STALE_NOTE, "");
    applied.push("stale re-enable note removed");
  }
} else {
  fail(
    "no retract mount line found, active or commented. Expected:\n" +
      '    router.post("/messages/:id/retract", requireAuth, retractMessage);',
  );
}

// ── Edit 3: add the unhide mount ─────────────────────────
//
// Placed immediately after hide, because they are one feature and reading them
// apart is how one of them gets forgotten again.

var HIDE = /^([ \t]*)router\.post\(\s*["']\/messages\/:id\/hide["'][^\n]*\n/m;

if (/router\.post\(\s*["']\/messages\/:id\/unhide["']/.test(src)) {
  // already present
} else if (HIDE.test(src)) {
  src = src.replace(HIDE, function (whole, indent) {
    return (
      whole +
      indent +
      'router.post("/messages/:id/unhide", requireAuth, unhideMessage);\n'
    );
  });
  applied.push("unhide route added");
} else {
  fail(
    "hide mount line not found, so there is nowhere obvious to put unhide.\n" +
      '  Expected: router.post("/messages/:id/hide", requireAuth, hideMessage);',
  );
}

if (applied.length === 0) {
  console.log("No changes — both routes are already mounted and imported.");
  process.exit(0);
}

fs.writeFileSync(ROUTES, src, "utf8");

console.log("Patched " + ROUTES);
applied.forEach(function (row) {
  console.log("  " + row);
});
console.log("");
console.log("  node --check src/routes/chat.routes.js");
console.log("  then restart the API and watch the boot output.");
