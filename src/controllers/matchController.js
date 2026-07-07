// localpulse/server/src/controllers/matchController.js
import Swipe from '../models/Swipe.js';
import Match from '../models/Match.js';
import User from '../models/User.js';
import Conversation from '../models/Conversation.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { notify } from '../lib/notify.js';

// Record a like/pass. On a like, check if the target already liked me → match.
export const swipe = asyncHandler(async (req, res) => {
  const { action } = req.body;
  const targetId = req.params.userId;

  if (!['like', 'pass'].includes(action)) throw ApiError.badRequest('action must be like or pass');
  if (String(targetId) === String(req.userId)) throw ApiError.badRequest("You can't swipe yourself");

  const target = await User.findById(targetId);
  if (!target) throw ApiError.notFound('User not found');

  // Upsert the swipe (re-swiping updates the action).
  await Swipe.updateOne(
    { user: req.userId, target: targetId },
    { $set: { action } },
    { upsert: true }
  );

  // A pass never creates a match.
  if (action === 'pass') return res.json({ matched: false });

  // Did the target already like me?
  const reciprocal = await Swipe.findOne({ user: targetId, target: req.userId, action: 'like' });
  if (!reciprocal) return res.json({ matched: false });

  // It's a match. Create it (sorted pair) if not already present.
  const pair = [String(req.userId), String(targetId)].sort();
  let match = await Match.findOne({ users: { $all: pair } });
  if (!match) {
    const conversation = await Conversation.create({ participants: pair });
    match = await Match.create({ users: pair, conversation: conversation._id });

    // Notify both people.
    await notify({
      userId: targetId, actorId: req.userId, type: 'match',
      title: "It's a match!", body: 'You have a new match',
    });
    await notify({
      userId: req.userId, actorId: targetId, type: 'match',
      title: "It's a match!", body: 'You have a new match',
    });
  }

  res.json({ matched: true, match: match.toClient(req.userId, target) });
});

// List my active matches, newest first, with the other person's card.
export const listMatches = asyncHandler(async (req, res) => {
  const matches = await Match.find({ users: req.userId, active: true })
    .sort({ lastInteractionAt: -1 })
    .populate('users');

  const result = matches.map((m) => {
    const other = m.users.find((u) => String(u._id) !== String(req.userId));
    return m.toClient(req.userId, other);
  });

  res.json({ matches: result });
});

// Unmatch: deactivate the match so chat is revoked on both sides.
export const unmatch = asyncHandler(async (req, res) => {
  const match = await Match.findById(req.params.id);
  if (!match) throw ApiError.notFound('Match not found');
  if (!match.users.some((u) => String(u) === String(req.userId))) throw ApiError.forbidden();

  match.active = false;
  await match.save();
  res.json({ ok: true });
});
