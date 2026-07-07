// localpulse/server/src/middleware/requireAdmin.js
import User from '../models/User.js';

// Runs after requireAuth. Loads the user, checks role, and stashes role on req
// so downstream controllers (e.g. comment delete) can also see it.
export async function requireAdmin(req, res, next) {
  try {
    const user = await User.findById(req.userId).select('role banned');
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.userRole = user.role;
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  } catch {
    return res.status(500).json({ error: 'Authorization check failed' });
  }
}
