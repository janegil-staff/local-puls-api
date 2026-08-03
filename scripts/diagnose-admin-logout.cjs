// qup-pulse-admin/scripts/diagnose-admin-logout.cjs
//
// READ ONLY. Writes nothing, changes nothing.
//
// Prints every place that can end a session on the way to /admin, so the
// moderator logout can be traced in one pass instead of one file at a time.
//
// There are only three possible causes:
//
//   1. request() in lib/api.js still throws AuthError on 403
//        -> patch-api-403-no-logout.cjs fixes it
//   2. adminChatApi.js has its OWN fetch with its own 403 -> logout
//        -> same fix, different file
//   3. the /admin layout checks role client-side and logs out instead of
//      hiding admin-only links
//        -> needs the layout, which this script locates and prints
//
//   node scripts/diagnose-admin-logout.cjs

var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var SRC = path.join(ROOT, "src");

function rel(p) {
  return path.relative(ROOT, p);
}

function line(title) {
  console.log("");
  console.log("=== " + title + " " + "=".repeat(Math.max(0, 58 - title.length)));
}

// ── Directory listings ───────────────────────────────────

function listDir(dir, depth, prefix) {
  if (!fs.existsSync(dir)) {
    console.log("  (missing) " + rel(dir));
    return;
  }
  var entries = fs.readdirSync(dir, { withFileTypes: true }).sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
  entries.forEach(function (entry) {
    if (entry.name === "node_modules" || entry.name.charAt(0) === ".") return;
    var full = path.join(dir, entry.name);
    console.log("  " + (prefix || "") + entry.name + (entry.isDirectory() ? "/" : ""));
    if (entry.isDirectory() && depth > 0) {
      listDir(full, depth - 1, (prefix || "") + "  ");
    }
  });
}

line("src/app/admin");
listDir(path.join(SRC, "app", "admin"), 1, "");

line("src/app/api/admin");
listDir(path.join(SRC, "app", "api", "admin"), 2, "");

// ── Candidate shell files ────────────────────────────────

var CANDIDATES = [
  "app/admin/layout.js",
  "app/admin/page.js",
  "app/AdminShell.js",
  "app/admin/AdminShell.js",
  "components/AdminShell.js",
  "components/admin/AdminShell.js",
];

line("admin shell candidates");
var found = [];
CANDIDATES.forEach(function (candidate) {
  var full = path.join(SRC, candidate);
  if (fs.existsSync(full)) {
    found.push(full);
    console.log("  FOUND   src/" + candidate);
  } else {
    console.log("  -       src/" + candidate);
  }
});

// ── Session-ending calls anywhere under src ──────────────
//
// Anything that clears a token or pushes to /login. If a moderator is being
// logged out and api.js is already patched, the cause is one of these lines.

var LOGOUT_PATTERNS = [
  /\bbounce\s*\(/,
  /\blogout\s*\(/,
  /\bsignOut\s*\(/,
  /clearToken/,
  /removeItem\(\s*["'][^"']*token/i,
  /(push|replace)\(\s*["']\/login/,
];

var ROLE_PATTERNS = [
  /role\s*[!=]==?\s*["']admin["']/,
  /["']admin["']\s*[!=]==?\s*role/,
  /isAdmin/,
  /requireAdmin/,
];

function walk(dir, hit) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    if (entry.name === "node_modules" || entry.name.charAt(0) === ".") return;
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, hit);
    if (!/\.(js|jsx)$/.test(entry.name)) return;
    hit(full, fs.readFileSync(full, "utf8"));
  });
}

function scan(title, patterns) {
  line(title);
  var any = false;
  walk(SRC, function (file, text) {
    text.split("\n").forEach(function (row, i) {
      var matched = patterns.some(function (re) {
        return re.test(row);
      });
      if (!matched) return;
      any = true;
      console.log("  " + rel(file) + ":" + (i + 1) + "  " + row.trim());
    });
  });
  if (!any) console.log("  (none found)");
}

scan("session-ending calls", LOGOUT_PATTERNS);
scan("client-side admin role checks", ROLE_PATTERNS);

// ── State of the two transport layers ────────────────────

function showBlock(file, label, needle, before, after) {
  line(label);
  var full = path.join(SRC, file);
  if (!fs.existsSync(full)) {
    console.log("  (missing) src/" + file);
    return;
  }
  var rows = fs.readFileSync(full, "utf8").split("\n");
  var at = -1;
  for (var i = 0; i < rows.length; i++) {
    if (needle.test(rows[i])) {
      at = i;
      break;
    }
  }
  if (at === -1) {
    console.log("  no 403 handling found in src/" + file);
    return;
  }
  var start = Math.max(0, at - before);
  var end = Math.min(rows.length, at + after);
  for (var j = start; j < end; j++) {
    console.log("  " + (j + 1) + "\t" + rows[j]);
  }
}

showBlock("lib/api.js", "lib/api.js — 403 branch", /res\.status === 403/, 4, 14);
showBlock(
  "lib/adminChatApi.js",
  "lib/adminChatApi.js — 403 / fetch",
  /res\.status === 403|await fetch\(/,
  3,
  16,
);

line("done");
console.log("  Nothing was modified.");
