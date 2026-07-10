// localpulse/server/src/lib/blocks.js
//
// Block checks, in one place. A block is SYMMETRIC: if A blocks B, neither
// sees the other — not in Discover, not in the inbox, not on a profile, not
// over a socket. Who initiated the block never affects who is hidden.
//
// Previously duplicated across chatController.js and socket/chat.js, with
// userController.js missing it entirely. Three copies of a security check is
// one copy too many, and the copy that goes missing is the hole.
import Block from '../models/Block.js';

// Is there a block in either direction between two users?
// Returns false for a null/undefined side — an anonymous viewer (optionalAuth)
// is blocked by nobody.
export async function blockedBetween(a, b) {
  if (!a || !b) return false;
  const block = await Block.findOne({
    $or: [
      { blocker: a, blocked: b },
      { blocker: b, blocked: a },
    ],
  });
  return Boolean(block);
}

// Every user blocked in either direction, as ObjectIds. Build queries with
// this ($nin) rather than post-filtering results — a post-filter silently
// corrupts pagination and unread counts.
export async function blockedIdsFor(userId) {
  if (!userId) return [];
  const blocks = await Block.find({
    $or: [{ blocker: userId }, { blocked: userId }],
  });
  return blocks.map((b) =>
    String(b.blocker) === String(userId) ? b.blocked : b.blocker
  );
}

// May this user see this conversation at all? Participant, and no block.
// The single gate for anything keyed by conversationId — HTTP or socket.
export async function canSeeConversation(userId, convo) {
  if (!convo) return false;
  if (!convo.participants.some((p) => String(p._id ?? p) === String(userId))) return false;
  const other = convo.participants.find((p) => String(p._id ?? p) !== String(userId));
  if (!other) return false;
  return !(await blockedBetween(userId, other._id ?? other));
}