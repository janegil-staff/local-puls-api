// localpulse/server/scripts/patch-chat-routes-retract3.cjs
//
// Fixes: "Route not found: POST /api/chat/messages/:id/retract"
//
// REPLACES patch-chat-routes-retract.cjs AND patch-chat-routes-retract2.cjs.
// Delete both.
//
// WHY THE LAST ONE WAS WRONG
// v2 found the chatController import list and split it on commas to read the
// names. That list contains a prose comment, and the prose contains commas
// ("not chat, not admin, not auth"), so fragments of English became entries in
// the name list and were rejoined into a mangled import. Parsing code by
// splitting on punctuation is the mistake; this version never does it.
//
// WHAT THIS DOES, line by line and nothing clever:
//   1. inside the chatController import block only, deletes commented lines —
//      the whole TEMPORARILY DISABLED note, which is now factually false:
//      chatController.js DOES export retractMessage, and the diagnostic
//      confirms retractedAt is referenced eight times. It describes a problem
//      that patch-chat-retraction.cjs already solved, and leaving it there is
//      how someone re-disables a working route next month.
//   2. adds retractMessage to the import if absent. unretractMessage is NOT
//      added: retraction is irreversible by decision and the confirm dialog
//      says so.
//   3. uncomments the retract mount line and drops the stale "Re-enable once"
//      note above it.
//   4. adds the unhide mount only if missing.
//
// SAFETY: the result is parsed as an ES module BEFORE anything is written. If
// it does not parse, the file is left untouched and the parse error is
// printed. A patch script that can corrupt a route file can take the whole API
// down, which is exactly what happened here.
//
// Idempotent.
//
//   node scripts/patch-chat-routes-retract3.cjs

var fs = require("fs");
var path = require("path");
var execFileSync = require("child_process").execFileSync;

var ROUTES = path.join(__dirname, "..", "src", "routes", "chat.routes.js");
var CONTROLLER = path.join(
  __dirname,
  "..",
  "src",
  "controllers",
  "chatController.js",
);

var IMPORT_SOURCE = "../controllers/chatController.js";

function fail(message) {
  console.error("ABORTED — " + message);
  console.error("No changes written.");
  process.exit(1);
}

if (!fs.existsSync(ROUTES)) fail("file not found: " + ROUTES);
if (!fs.existsSync(CONTROLLER)) fail("file not found: " + CONTROLLER);

// ── Guard: handler must exist ────────────────────────────

var controller = fs.readFileSync(CONTROLLER, "utf8");
if (
  controller.indexOf("export async function retractMessage") === -1 &&
  controller.indexOf("export function retractMessage") === -1
) {
  fail(
    "chatController.js does not export retractMessage.\n" +
      "  Run patch-chat-retraction.cjs first. Importing an absent name is an\n" +
      "  ESM load failure, which takes down every route, not just this one.",
  );
}

var original = fs.readFileSync(ROUTES, "utf8");
var lines = original.split("\n");
var applied = [];

// ── Locate the import block by its source path ───────────
//
// Found by scanning for the closing line, then walking backwards to the
// opening brace. No regex spanning multiple statements, which is what let v2
// swallow the express import.

var closeAt = -1;
for (var i = 0; i < lines.length; i++) {
  if (lines[i].indexOf(IMPORT_SOURCE) !== -1 && lines[i].indexOf("}") !== -1) {
    closeAt = i;
    break;
  }
}
if (closeAt === -1) fail("could not find the chatController.js import block.");

var openAt = -1;
for (var j = closeAt; j >= 0; j--) {
  if (/^\s*import\s*\{\s*$/.test(lines[j])) {
    openAt = j;
    break;
  }
}
if (openAt === -1) fail("could not find the opening of the import block.");

// ── Edit 1 & 2: clean the import block ───────────────────

var body = lines.slice(openAt + 1, closeAt);
var kept = [];
var removedComments = 0;
var hasRetract = false;

body.forEach(function (row) {
  var trimmed = row.trim();
  if (trimmed.indexOf("//") === 0) {
    removedComments++;
    return;
  }
  if (trimmed === "retractMessage," || trimmed === "retractMessage") {
    hasRetract = true;
  }
  if (trimmed.length > 0) kept.push(row);
});

if (!hasRetract) {
  kept.push("  retractMessage,");
  applied.push("import: retractMessage added");
}
if (removedComments > 0) {
  applied.push(
    "import: " + removedComments + " stale comment line(s) removed",
  );
}

lines = lines
  .slice(0, openAt + 1)
  .concat(kept)
  .concat(lines.slice(closeAt));

// ── Edit 3: the retract mount ────────────────────────────

var activeRetract = lines.some(function (row) {
  return /^\s*router\.post\(\s*["']\/messages\/:id\/retract["']/.test(row);
});

if (!activeRetract) {
  var found = false;
  for (var k = 0; k < lines.length; k++) {
    var m = lines[k].match(
      /^([ \t]*)\/\/\s?(router\.post\(\s*["']\/messages\/:id\/retract["'].*)$/,
    );
    if (!m) continue;
    lines[k] = m[1] + m[2];
    found = true;
    applied.push("retract mount uncommented");

    // Walk back over the stale "Re-enable once..." note directly above it.
    var n = k - 1;
    while (n >= 0 && /^\s*\/\//.test(lines[n]) && /Re-enable|404s until|dead\s*$|server\./i.test(lines[n])) {
      lines.splice(n, 1);
      n--;
      k--;
    }
    break;
  }
  if (!found) fail("no retract mount line found, active or commented.");
}

// ── Edit 4: the unhide mount ─────────────────────────────

var hasUnhide = lines.some(function (row) {
  return /^\s*router\.post\(\s*["']\/messages\/:id\/unhide["']/.test(row);
});

if (!hasUnhide) {
  for (var q = 0; q < lines.length; q++) {
    var h = lines[q].match(
      /^([ \t]*)router\.post\(\s*["']\/messages\/:id\/hide["']/,
    );
    if (!h) continue;
    lines.splice(
      q + 1,
      0,
      h[1] + 'router.post("/messages/:id/unhide", requireAuth, unhideMessage);',
    );
    applied.push("unhide mount added");
    break;
  }
}

if (applied.length === 0) {
  console.log("No changes — already imported and mounted.");
  process.exit(0);
}

var next = lines.join("\n");

// ── Validate BEFORE writing ──────────────────────────────

try {
  execFileSync("node", ["--input-type=module", "--check"], {
    input: next,
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

fs.writeFileSync(ROUTES, next, "utf8");

console.log("Patched " + ROUTES);
applied.forEach(function (row) {
  console.log("  " + row);
});
console.log("");
console.log("  Output was parsed as ESM before writing.");
console.log("  git diff src/routes/chat.routes.js");
console.log("  then restart the API and watch the boot output.");
