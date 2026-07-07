// localpulse/server/src/controllers/authController.js
import User from '../models/User.js';
import { signToken } from '../middleware/auth.js';

export async function register(req, res) {
  try {
    const { email, password, pin, displayName } = req.body;
    let { username } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (pin != null && !/^\d{4,6}$/.test(String(pin))) {
      return res.status(400).json({ error: 'PIN must be 4 to 6 digits' });
    }

    // If no username supplied (new signup flow uses email only), derive a unique
    // one from the email local-part.
    if (!username) {
      const base = String(email).split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || 'user';
      username = base;
      let n = 0;
      // Ensure uniqueness.
      while (await User.exists({ username })) {
        n += 1;
        username = `${base}${n}`;
      }
    }

    const exists = await User.findOne({ $or: [{ email: email.toLowerCase() }, { username }] });
    if (exists) return res.status(409).json({ error: 'Username or email already in use' });

    const user = new User({ username, email, displayName: displayName || username });
    await user.setPassword(password);
    if (pin != null) await user.setPin(pin);
    await user.save();

    const token = signToken(user._id);
    return res.status(201).json({ token, user: user.toPublic() });
  } catch (err) {
    console.error('register error', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
}

export async function login(req, res) {
  try {
    const { emailOrUsername, password } = req.body;
    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'Credentials required' });
    }
    const user = await User.findOne({
      $or: [{ email: String(emailOrUsername).toLowerCase() }, { username: emailOrUsername }],
    });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    // The credential may be the password OR the PIN (app-lock login sends the
    // PIN here). Accept either.
    let ok = await user.checkPassword(password);
    if (!ok) ok = await user.checkPin(password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken(user._id);
    return res.json({ token, user: user.toPublic() });
  } catch (err) {
    console.error('login error', err);
    return res.status(500).json({ error: 'Login failed' });
  }
}

export async function me(req, res) {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json({ user: user.toPublic() });
}
