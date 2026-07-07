// localpulse/server/src/controllers/notificationController.js
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const listNotifications = asyncHandler(async (req, res) => {
  const { before, limit } = req.query;
  const lim = Math.min(Number(limit) || 30, 50);
  const notifs = await Notification.find({
    user: req.userId,
    ...(before ? { createdAt: { $lt: new Date(before) } } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(lim)
    .populate('actor');
  res.json({ notifications: notifs.map((n) => n.toClient()) });
});

export const unreadCount = asyncHandler(async (req, res) => {
  const count = await Notification.countDocuments({ user: req.userId, read: false });
  res.json({ count });
});

export const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ user: req.userId, read: false }, { read: true });
  res.json({ ok: true });
});

export const registerPushToken = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  await User.updateOne({ _id: req.userId }, { $addToSet: { pushTokens: token } });
  res.json({ ok: true });
});

export const removePushToken = asyncHandler(async (req, res) => {
  const { token } = req.body;
  await User.updateOne({ _id: req.userId }, { $pull: { pushTokens: token } });
  res.json({ ok: true });
});
