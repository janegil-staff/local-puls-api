// localpulse/server/scripts/patch-open-conversation-notify.cjs
//
// Fixes: a new message request does not bump the recipient's badge until the
// app is restarted.
//
// THE CAUSE. The badge is unread + requestCount, and both clients compute it
// correctly. requestCount counts PENDING CONVERSATIONS, not messages — and
// openConversation creates that conversation the moment someone taps Message,
// while emitting nothing at all. chat:notify is fired from persistMessage, so
// it only covers the case where the requester also SENDS. Tap Message and walk
// away and the recipient's count changes server-side with no event, so nothing
// tells the client to refetch.
//
// THE FIX. Emit chat:notify to the recipient when a pending conversation is
// created. Reusing that event rather than inventing chat:request is deliberate:
// both clients already bind it and call refreshUnread, so this needs no client
// change and web gets the same fix. The handler ignores the conversationId
// unless it matches the open thread, which it cannot here.
//
// ONLY ON CREATION. The fast path — the conversation already exists — emits
// nothing, so re-opening a thread does not spam the other side with refreshes.
// The E11000 branch does not emit either: losing that race means someone else
// created it, and whoever won already sent the event.
//
// WORTH KNOWING, not fixed here. Creating the thread on tap rather than on
// first send is what makes this necessary at all, and it also leaves permanent
// empty requests in the recipient's list when someone taps and never writes
// anything. chatUnreadCount's own comment argues for making creation lazy. That
// would fix both and make this emit unnecessary — a better change, and a bigger
// one than a patch script should make.
//
// Idempotent. Validates the output as an ES module before writing.
//
//   node scripts/patch-open-conversation-notify.cjs

var fs = require("fs");
var path = require("path");
var execFileSync = require("child_process").execFileSync;

var FILE = path.join(
  __dirname,
  "..",
  "src",
  "controllers",
  "chatController.js",
);

function fail(message) {
  console.error("ABORTED — " + message);
  console.error("No changes written.");
  process.exit(1);
}

if (!fs.existsSync(FILE)) fail("file not found: " + FILE);

var src = fs.readFileSync(FILE, "utf8");
var applied = [];

if (src.indexOf("REQUEST_NOTIFY") !== -1) {
  console.log("No changes — openConversation already notifies the recipient.");
  process.exit(0);
}

// ── Edit 1: track whether we created it ──────────────────

var FIND = /( *)let convo = await Conversation\.findOne\(\{ pairKey \}\);/;
if (!FIND.test(src)) {
  fail(
    "could not find `let convo = await Conversation.findOne({ pairKey });`\n" +
      "  in openConversation.",
  );
}
src = src.replace(FIND, function (whole, indent) {
  return (
    whole +
    "\n\n" +
    indent +
    "// Only a NEWLY created pending thread notifies the recipient. Re-opening\n" +
    indent +
    "// an existing conversation must not fire anything.\n" +
    indent +
    "let created = false;"
  );
});
applied.push("created flag");

// ── Edit 2: set it ───────────────────────────────────────

var CREATE =
  /( *)convo = await Conversation\.create\(\{\n[\s\S]*?status: "pending",\n *\}\);/;
if (!CREATE.test(src)) {
  fail("could not find the Conversation.create call in openConversation.");
}
src = src.replace(CREATE, function (whole, indent) {
  return whole + "\n" + indent + "created = true;";
});
applied.push("created = true");

// ── Edit 3: emit before responding ───────────────────────

var RETURN =
  /( *)return res\.json\(\{\n( *)conversationId: String\(convo\._id\),\n *status: convo\.status,\n *\}\);/;

if (!RETURN.test(src)) {
  fail("could not find openConversation's success response.");
}

src = src.replace(RETURN, function (whole, indent) {
  return (
    indent +
    "// REQUEST_NOTIFY — a request with no message still changes the\n" +
    indent +
    "// recipient's requestCount, and nothing else emits for it. persistMessage\n" +
    indent +
    "// fires chat:notify only when someone actually sends, so without this the\n" +
    indent +
    "// badge does not move until the app next cold-starts and primes.\n" +
    indent +
    "//\n" +
    indent +
    "// chat:notify rather than a new event name: both clients already bind it\n" +
    indent +
    "// and call refreshUnread, so this needs no client change.\n" +
    indent +
    "if (created && convo.status === \"pending\") {\n" +
    indent +
    "  const io = req.app.get(\"io\");\n" +
    indent +
    "  if (io) {\n" +
    indent +
    "    io.to(`user:${userId}`).emit(\"chat:notify\", {\n" +
    indent +
    "      conversationId: String(convo._id),\n" +
    indent +
    "    });\n" +
    indent +
    "  }\n" +
    indent +
    "}\n\n" +
    whole
  );
});
applied.push("chat:notify emit");

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
console.log("  Test: tap Message on a profile WITHOUT sending. The other");
console.log("  account's badge should move immediately. Watch the recipient");
console.log("  for [chatStore] chat:notify received.");
