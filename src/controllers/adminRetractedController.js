// localpulse/server/src/controllers/adminRetractedController.js
//
// Moderation read for RETRACTED messages — the fourth visibility mechanism,
// and until now the only one with no admin surface at all.
//
// The other three are all reachable:
//   hiddenFor        -> adminListHiddenMessages   ("Deleted messages")
//   removedByAdmin   -> adminListRemovedMessages  ("Removed by moderators")
//   Report           -> listReports               ("Reports")
//   retractedAt      -> this                      ("Retracted")
//
// WHY IT MATTERS. retractMessage refuses once a Report references the message,
// so a reported message cannot be withdrawn — that is the protection that
// counts and it is already in place. But a message retracted BEFORE anyone
// reports it was unreachable from every moderation surface, while its text sat
// in the database untouched. That is an ordering race a bad actor can win by
// acting first, and "send abuse, retract immediately" should not be a way to
// put something beyond moderation.
//
// This does not undo anything. Retraction stays irreversible: there is no
// restore here and there should not be one. The point is that a moderator can
// still SEE what was said when a complaint arrives by another route — the
// recipient describing it, an account under review, a pattern across threads.
//
// Separate controller file rather than more surface in adminController.js,
// which is already carrying reports, users, posts, hidden and removed.
//
// PRIVACY. This is a privileged read of private messages, unanchored to any
// report — the same standing as the hidden-messages list, and weaker than the
// removed list (where every row is something this team already acted on).
// Gate it with requireModerator, not requireAuth. The page carries a warning
// for the same reason /admin/deleted does.

import Message from "../models/Message.js";
import Report from "../models/Report.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

// ── GET /admin/messages/retracted ─────────────────────────────────────
//
// Newest first. Capped server-side: an unbounded read of every message anyone
// has ever retracted is both a slow query and more private conversation than
// any single moderation task needs on screen at once.
export async function adminListRetractedMessages(req, res) {
  try {
    const raw = Number(req.query.limit);
    const limit = Math.min(
      Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT,
      MAX_LIMIT,
    );

    const docs = await Message.find({ retractedAt: { $exists: true } })
      .sort({ retractedAt: -1 })
      .limit(limit)
      .populate("sender");

    // Which of these already have a report against them. retractMessage
    // refuses once a Report exists, so a row that is BOTH retracted and
    // reported means the report was filed after the retraction — the
    // recipient complaining about something already withdrawn. Worth
    // surfacing: it is the case where a moderator most needs the text, and
    // the thread will not contain it.
    const ids = docs.map((d) => d._id);
    const reports = await Report.find({ message: { $in: ids } }).select(
      "message",
    );
    const reported = new Set(reports.map((r) => String(r.message)));

    const messages = docs.map((doc) => {
      // toAdmin() returns the ORIGINAL text regardless of visibility state —
      // retraction never blanks the document, the same property restore
      // depends on for removed messages. If Message.js has no toAdmin, fall
      // back to explicit fields rather than toClient(), which would apply the
      // participant-facing rules this surface exists to bypass.
      const base =
        typeof doc.toAdmin === "function"
          ? doc.toAdmin()
          : {
              id: String(doc._id),
              text: doc.text || "",
              imageUrl: doc.imageUrl || "",
              createdAt: doc.createdAt,
            };

      return {
        ...base,
        id: String(doc._id),
        conversationId: String(doc.conversation),
        retractedAt: doc.retractedAt,
        hiddenCount: Array.isArray(doc.hiddenFor) ? doc.hiddenFor.length : 0,
        isReported: reported.has(String(doc._id)),
        sender: doc.sender ? doc.sender.toPublic() : null,
      };
    });

    return res.json({ messages });
  } catch (err) {
    console.error("[adminListRetractedMessages] failed:", err);
    return res.status(500).json({ error: "Failed to load retracted messages" });
  }
}
