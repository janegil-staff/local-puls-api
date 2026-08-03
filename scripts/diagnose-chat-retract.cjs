// localpulse/server/scripts/diagnose-chat-retract.cjs
//
// READ ONLY. Writes nothing.
//
// "Route not found: POST /api/chat/messages/:id/retract" has exactly four
// possible causes, and this prints the state of all four:
//
//   1. chatController.js does not export retractMessage
//        -> patch-chat-retraction.cjs never ran
//   2. chat.routes.js has no mount line, or still has it commented
//        -> patch-chat-routes-retract.cjs never ran, or found nothing
//   3. the route is mounted under a different path than the client calls
//        -> the 404 is real and the URL is wrong on one side
//   4. everything is correct on disk but the API was not restarted
//        -> nothing on disk can show this; check the process start time
//
//   node scripts/diagnose-chat-retract.cjs

var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var SRC = path.join(ROOT, "src");

function line(title) {
  console.log("");
  console.log("=== " + title + " " + "=".repeat(Math.max(0, 56 - title.length)));
}

function read(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

// ── 1. Controller exports ────────────────────────────────

line("chatController.js exports");
var controller = read(path.join(SRC, "controllers", "chatController.js"));
if (!controller) {
  console.log("  (missing) src/controllers/chatController.js");
} else {
  ["retractMessage", "unhideMessage", "hideMessage"].forEach(function (name) {
    var present =
      controller.indexOf("export async function " + name) !== -1 ||
      controller.indexOf("export function " + name) !== -1;
    console.log("  " + (present ? "OK      " : "MISSING ") + name);
  });
  var filters = (controller.match(/retractedAt/g) || []).length;
  console.log("  retractedAt referenced " + filters + " time(s)");
}

// ── 2 & 3. Route file ────────────────────────────────────

line("chat.routes.js — every retract / unhide line");
var routesPath = path.join(SRC, "routes", "chat.routes.js");
var routes = read(routesPath);
if (!routes) {
  console.log("  (missing) src/routes/chat.routes.js");
} else {
  var found = false;
  routes.split("\n").forEach(function (row, i) {
    if (/retract|unhide/i.test(row)) {
      found = true;
      var commented = /^\s*\/\//.test(row);
      console.log(
        "  " + (i + 1) + "\t" + (commented ? "[COMMENTED] " : "[active]    ") + row.trim(),
      );
    }
  });
  if (!found) console.log("  (no retract or unhide lines at all)");
}

line("chat.routes.js — all mounted paths");
if (routes) {
  routes.split("\n").forEach(function (row, i) {
    if (/router\.(get|post|patch|put|delete)\s*\(/.test(row)) {
      console.log("  " + (i + 1) + "\t" + row.trim());
    }
  });
}

// ── 3. Where the router is mounted ───────────────────────

line("where chat.routes is mounted");
var ENTRIES = ["app.js", "server.js", "index.js", "src/app.js", "src/server.js", "src/index.js"];
var mounted = false;
ENTRIES.forEach(function (entry) {
  var full = path.join(ROOT, entry);
  var text = read(full);
  if (!text) return;
  text.split("\n").forEach(function (row, i) {
    if (/app\.use\s*\(/.test(row) && /chat/i.test(row)) {
      mounted = true;
      console.log("  " + entry + ":" + (i + 1) + "  " + row.trim());
    }
  });
});
if (!mounted) {
  console.log("  (no app.use line mentioning chat found in: " + ENTRIES.join(", ") + ")");
}

line("done");
console.log("  Nothing was modified.");
console.log("");
console.log("  Read it as: the client calls POST /api/chat/messages/:id/retract.");
console.log("  Mount path + route path must concatenate to exactly that.");
