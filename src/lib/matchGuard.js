// localpulse/server/src/lib/matchGuard.js
import Match from '../models/Match.js';
import Conversation from '../models/Conversation.js';

// True if the two users have an active match.
export async function usersAreMatched(a, b) {
  const pair = [String(a), String(b)].sort();
  const match = await Match.findOne({ users: { $all: pair }, active: true });
  return Boolean(match);
}

// True if `userId` may access `conversationId`: they must be a participant AND
// the match backing it must still be active.
export async function canAccessConversation(userId, conversationId) {
  const convo = await Conversation.findById(conversationId);
  if (!convo) return false;
  if (!convo.participants.some((p) => String(p) === String(userId))) return false;

  const other = convo.participants.find((p) => String(p) !== String(userId));
  if (!other) return false;
  return usersAreMatched(userId, other);
}
