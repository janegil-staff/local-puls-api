// localpulse/server/src/lib/notify.js
import Notification from '../models/Notification.js';
import User from '../models/User.js';

// Sends a push message via Expo's push API. No SDK needed — it's a plain POST.
async function sendExpoPush(tokens, title, body, data = {}) {
  const valid = tokens.filter((t) => typeof t === 'string' && t.startsWith('ExponentPushToken'));
  if (!valid.length) return;

  const messages = valid.map((to) => ({ to, title, body, data, sound: 'default' }));
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    console.error('Expo push failed', err);
  }
}

// Create an in-app notification and fire a push to the recipient's devices.
// Skips self-notifications (e.g. liking your own post).
export async function notify({ userId, actorId, type, postId, title, body }) {
  if (String(userId) === String(actorId)) return;

  await Notification.create({ user: userId, actor: actorId, type, post: postId });

  const user = await User.findById(userId).select('pushTokens');
  if (user?.pushTokens?.length) {
    await sendExpoPush(user.pushTokens, title, body, { type, postId: String(postId || '') });
  }
}
