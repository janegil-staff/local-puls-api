// local-pulse-api/scripts/patch-chat-retraction.cjs
//
// Adds retraction to chatController.js properly. Six edits:
//
//   1. RETRACTED_EXCLUSION constant
//   2. getMessages          — filter retracted out of the thread
//   3. listConversations    — filter retracted out of the unread aggregate
//   4. chatUnreadCount      — filter retracted out of the badge count
//   5. findMessageForParticipant — select retractedAt (it currently does not)
//   6. append unhideMessage + retractMessage
//
// Edits 2-4 are the ones that matter. hiddenFor and removedByAdmin.at are each
// filtered at three read sites, marked HIDDEN_FILTER and REMOVED_FILTER 1..3
// in the file. Retraction is a THIRD visibility mechanism and had none: set
// retractedAt without these and the message vanishes live over the socket,
// then returns on reload and keeps counting toward the ✉ badge.
//
// Edit 5 fixes a bug in retractMessage itself — the helper's select does not
// pull retractedAt, so the already-retracted check would always see undefined.
//
// There is deliberately no unretractMessage. Retraction is irreversible by
// decision and the confirm dialog already says so.
//
// Usage:
//   node scripts/patch-chat-retraction.cjs
//   node scripts/patch-chat-retraction.cjs --dry
//
// Aborts on any missing anchor rather than half-applying. Idempotent.
// No .bak files — git is the safety net.

var fs = require("fs");

var FILE = "src/controllers/chatController.js";
var DRY = process.argv.indexOf("--dry") !== -1;

function fail(msg) {
  console.error("\n✗ " + msg + "\n");
  process.exit(1);
}

if (!fs.existsSync(FILE)) {
  fail("Not found: " + FILE + " (run from the local-pulse-api root)");
}

var src = fs.readFileSync(FILE, "utf8");
var original = src;
var applied = [];
var skipped = [];

// Duplicate exports are a SyntaxError — the module stops parsing entirely and
// every route importing from it dies. Check before appending anything.
["unhideMessage", "retractMessage"].forEach(function (name) {
  if (new RegExp("export\\s+async\\s+function\\s+" + name + "\\b").test(src)) {
    fail(
      name + " already exists in " + FILE + ".\n" +
        "  Appending would make the module unparseable.",
    );
  }
});

// ── 1. constant ───────────────────────────────────────────────────────────

var CONST_ANCHOR =
  'const REMOVED_EXCLUSION = { "removedByAdmin.at": { $exists: false } };';

var CONST_NEW =
  CONST_ANCHOR +
  "\n\n" +
  "// The same idea for retraction — the sender withdrawing their own message,\n" +
  "// gone for BOTH participants. A third visibility mechanism alongside\n" +
  "// hiddenFor and removedByAdmin, and it needs the same treatment at every\n" +
  "// participant-facing read: sites are marked RETRACTED_FILTER below.\n" +
  "//\n" +
  "// Plain path, not a dotted one: retractedAt is a top-level Date, so\n" +
  "// { $exists: false } is true exactly when the message has not been\n" +
  "// retracted. No empty-subdocument trap like removedByAdmin has.\n" +
  "const RETRACTED_EXCLUSION = { retractedAt: { $exists: false } };";

if (src.indexOf("RETRACTED_EXCLUSION") !== -1) {
  skipped.push("constant");
} else if (src.indexOf(CONST_ANCHOR) !== -1) {
  src = src.replace(CONST_ANCHOR, CONST_NEW);
  applied.push("constant");
} else {
  fail("REMOVED_EXCLUSION constant not found — file may have changed.");
}

// ── 2. getMessages thread query ───────────────────────────────────────────

var THREAD_OLD =
  "    const query = {\n" +
  "      conversation: id,\n" +
  "      hiddenFor: { $ne: me },\n" +
  "      ...REMOVED_EXCLUSION,\n" +
  "    };";

var THREAD_NEW =
  "    const query = {\n" +
  "      conversation: id,\n" +
  "      hiddenFor: { $ne: me },\n" +
  "      ...REMOVED_EXCLUSION,\n" +
  "      // RETRACTED_FILTER 1 of 3 — the thread. Without this a retracted\n" +
  "      // message disappears live over the socket and comes straight back on\n" +
  "      // reload, which reads as the feature not working at all.\n" +
  "      ...RETRACTED_EXCLUSION,\n" +
  "    };";

if (src.indexOf("RETRACTED_FILTER 1 of 3") !== -1) {
  skipped.push("getMessages");
} else if (src.indexOf(THREAD_OLD) !== -1) {
  src = src.replace(THREAD_OLD, THREAD_NEW);
  applied.push("getMessages");
} else {
  fail("getMessages query block not found — check indentation and spread order.");
}

// ── 3. listConversations unread aggregate ─────────────────────────────────

var AGG_OLD =
  '          "removedByAdmin.at": { $exists: false },\n' +
  "        },\n" +
  "      },\n" +
  "      { $group:";

var AGG_NEW =
  '          "removedByAdmin.at": { $exists: false },\n' +
  "          // RETRACTED_FILTER 2 of 3 — the per-conversation unread count. A\n" +
  "          // retracted message is not in the thread, so a count including it\n" +
  "          // can never be cleared by opening the conversation.\n" +
  "          retractedAt: { $exists: false },\n" +
  "        },\n" +
  "      },\n" +
  "      { $group:";

if (src.indexOf("RETRACTED_FILTER 2 of 3") !== -1) {
  skipped.push("aggregate");
} else if (src.indexOf(AGG_OLD) !== -1) {
  src = src.replace(AGG_OLD, AGG_NEW);
  applied.push("aggregate");
} else {
  fail("Unread aggregate $match block not found.");
}

// ── 4. chatUnreadCount ────────────────────────────────────────────────────

var BADGE_OLD =
  '      "removedByAdmin.at": { $exists: false },\n' +
  "    });";

var BADGE_NEW =
  '      "removedByAdmin.at": { $exists: false },\n' +
  "      // RETRACTED_FILTER 3 of 3 — the ✉ badge. Same failure as the other\n" +
  "      // two: a permanent count for a message that is nowhere to be found.\n" +
  "      retractedAt: { $exists: false },\n" +
  "    });";

if (src.indexOf("RETRACTED_FILTER 3 of 3") !== -1) {
  skipped.push("badge");
} else if (src.indexOf(BADGE_OLD) !== -1) {
  src = src.replace(BADGE_OLD, BADGE_NEW);
  applied.push("badge");
} else {
  fail("chatUnreadCount countDocuments block not found.");
}

// ── 5. select retractedAt ─────────────────────────────────────────────────

var SELECT_OLD = '"_id conversation sender text imageUrl removedByAdmin",';
var SELECT_NEW =
  '"_id conversation sender text imageUrl removedByAdmin retractedAt",';

if (src.indexOf(SELECT_NEW) !== -1) {
  skipped.push("select");
} else if (src.indexOf(SELECT_OLD) !== -1) {
  src = src.replace(SELECT_OLD, SELECT_NEW);
  applied.push("select");
} else {
  fail("findMessageForParticipant select not found.");
}

// ── 6. handlers ───────────────────────────────────────────────────────────

var ADDITION = `
// ── Unhide a message I previously hid ─────────────────────────────────
//
// The mirror of hideMessage: $pull instead of $addToSet. No time limit —
// hiding never affected the other party, so restoring my own view cannot
// surprise anyone.
//
// The comment on hideMessage says there is no unhide endpoint "because a UI
// listing what you have hidden would be needed to reach it". That is no longer
// true: the web client shows an undo toast on hide, and undo calls this. Until
// now that toast offered a reversal that 404'd.
//
// Idempotent. Unhiding something not hidden is a no-op 200, matching how
// duplicate reports are handled.
//
// No socket broadcast, for the same reason hideMessage has none: the change
// affects exactly one viewer, and telling the other participant anything would
// leak that you had hidden their message.
export async function unhideMessage(req, res) {
  try {
    const me = currentUserId(req);
    const found = await findMessageForParticipant(req.params.id, me);
    if (found.error)
      return res.status(found.status).json({ error: found.error });

    const r = await Message.updateOne(
      { _id: found.msg._id },
      { $pull: { hiddenFor: me } },
    );
    console.log("[unhideMessage]", String(found.msg._id), me, r.modifiedCount);

    return res.json({ ok: true, messageId: String(found.msg._id) });
  } catch (err) {
    console.error("[unhideMessage] failed:", err);
    return res.status(500).json({ error: "Failed to unhide message" });
  }
}

// ── Retract my own message — gone for BOTH participants ───────────────
//
// The third visibility mechanism after hiddenFor and removedByAdmin, and the
// only one the sender controls. The three RETRACTED_FILTER sites above are
// what make it real; this handler only sets the flag.
//
// The text is NEVER blanked, for the same reason removal does not blank it: a
// report filed before a retraction keeps its subject, and a moderator reading
// the thread needs the real message.
//
// IRREVERSIBLE, by decision. There is no unretractMessage and adding one would
// be a mistake:
//
//   - the confirm dialog tells the sender before they act ("Dette kan ikke
//     angres"), so undo would make shipped copy false in the other direction
//   - un-retract lets someone remove and restore a message around a
//     moderator's review of it, so the queue and the thread disagree about
//     what was ever said
//
// Refuses once reported. Without this, reporting is defeatable by the reported
// party: report arrives, sender retracts, the moderator opens a thread with a
// hole in it. Report.snapshotText survives, but the surrounding thread is half
// the evidence — reportMessage's own comment makes that point.
export async function retractMessage(req, res) {
  try {
    const me = currentUserId(req);
    const found = await findMessageForParticipant(req.params.id, me);
    if (found.error)
      return res.status(found.status).json({ error: found.error });

    const msg = found.msg;

    // Participation is not enough — retraction is the SENDER withdrawing their
    // own words. Acting on the other party's message is what hide is for.
    if (String(msg.sender) !== me) {
      return res.status(403).json({
        error: "You can only retract your own messages",
        code: "not_sender",
      });
    }

    // Already retracted: no-op 200. A double click or a second device must not
    // produce a failure. Works because findMessageForParticipant now selects
    // retractedAt — it did not before this patch.
    if (msg.retractedAt) {
      return res.json({
        ok: true,
        alreadyRetracted: true,
        messageId: String(msg._id),
      });
    }

    const reported = await Report.exists({ message: msg._id });
    if (reported) {
      return res.status(409).json({
        error: "This message has been reported and cannot be retracted",
        code: "message_reported",
      });
    }

    await Message.updateOne(
      { _id: msg._id },
      { $set: { retractedAt: new Date() } },
    );

    // Both participants are in the conversation room, so one emit reaches the
    // recipient and the sender's other devices. Unlike removal, retraction is
    // symmetric and carries no per-participant difference, so a single room
    // payload is correct here — see the warning on persistMessage's emit.
    const io = req.app.get("io");
    if (io) {
      io.to(\`conversation:\${msg.conversation}\`).emit(
        "chat:message:retracted",
        {
          conversationId: String(msg.conversation),
          messageId: String(msg._id),
        },
      );
    }

    console.log("[retractMessage]", String(msg._id), me);
    return res.json({ ok: true, messageId: String(msg._id) });
  } catch (err) {
    console.error("[retractMessage] failed:", err);
    return res.status(500).json({ error: "Failed to retract message" });
  }
}
`;

src = src.replace(/\s*$/, "\n") + ADDITION;
applied.push("handlers");

// ── write ─────────────────────────────────────────────────────────────────

if (src === original) {
  console.log("No changes — already applied.");
  process.exit(0);
}

if (!DRY) fs.writeFileSync(FILE, src, "utf8");

console.log((DRY ? "[dry run] " : "") + "Patched " + FILE);
console.log("  applied: " + applied.join(", "));
if (skipped.length) console.log("  already present: " + skipped.join(", "));

console.log("\nNext:");
console.log("  node --check " + FILE);
console.log("  uncomment unhideMessage + retractMessage in src/routes/chat.routes.js");
console.log("  (import list AND the two router.post lines), then restart.");

console.log(
  "\n  STILL OUTSTANDING: Conversation.lastMessage is not recomputed on\n" +
    "  retract, so the inbox row keeps showing the retracted text — the leak\n" +
    "  the file header documents. adminRemoveMessage solves it with\n" +
    "  recomputeConversationPreview; the same call belongs in retractMessage.\n" +
    "  Not wired here because that helper lives in adminController.js and\n" +
    "  importing across controllers wants a deliberate move to lib/.",
);
