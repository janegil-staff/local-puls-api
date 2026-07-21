// localpulse/server/src/controllers/authController.js
import crypto from 'crypto';
import User, { defaultShowFor } from '../models/User.js';
import { signToken } from '../middleware/auth.js';
import bcrypt from 'bcryptjs';
import { sendVerificationEmail, sendPinResetEmail } from '../lib/mail.js';

const RESET_TTL_MS = 10 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;
const RESET_MAX_REQUESTS = 3;
const RESET_REQUEST_WINDOW_MS = 60 * 60 * 1000;

// 4 digits, zero-padded. crypto.randomInt is uniform; Math.random is not, and
// a biased 4-digit code is meaningfully weaker than an unbiased one.
function newResetCode() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

// Clear every reset field. Used on success, on exhaustion, and on expiry.
function clearReset(user) {
  user.pinResetHash = undefined;
  user.pinResetExpires = undefined;
  user.pinResetAttempts = 0;
}
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

function newVerifyToken() {
  return crypto.randomBytes(32).toString('hex');
}
// Request a reset code. ALWAYS responds 200, whether or not the email exists —
// otherwise this endpoint is a user-enumeration oracle.
export async function requestPinReset(req, res) {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await User.findOne({ email });
    if (!user) return res.json({ ok: true });

    // Throttle. Without this, an attacker burns the 5-attempt budget, requests
    // a fresh code, and repeats — turning a 10,000-space secret into a grind.
    const now = Date.now();
    const recent = (user.pinResetRequests || []).filter(
      (d) => now - new Date(d).getTime() < RESET_REQUEST_WINDOW_MS,
    );
    if (recent.length >= RESET_MAX_REQUESTS) {
      // Still 200 — the caller learns nothing either way.
      return res.json({ ok: true });
    }

    const code = newResetCode();
    user.pinResetHash = await bcrypt.hash(code, 10);
    user.pinResetExpires = new Date(now + RESET_TTL_MS);
    user.pinResetAttempts = 0;
    user.pinResetRequests = [...recent, new Date()];
    await user.save();

    sendPinResetEmail(user, code);
    return res.json({ ok: true });
  } catch (err) {
    console.error('requestPinReset error', err);
    return res.status(500).json({ error: 'Could not send reset code' });
  }
}

// Verify the code and set a new PIN in one step. Splitting it into
// verify-then-set would leave a window where a verified code sits unused, and
// gains nothing: the client already has both values by the time it submits.
export async function resetPin(req, res) {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const pin = String(req.body.pin || '').trim();

    if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 digits' });

    const user = await User.findOne({ email });

    // Generic message on every failure path below: a distinct "no such account"
    // would leak which emails are registered.
    const invalid = () => res.status(400).json({ error: 'Invalid or expired code' });

    if (!user || !user.pinResetHash || !user.pinResetExpires) return invalid();

    if (user.pinResetExpires.getTime() < Date.now()) {
      clearReset(user);
      await user.save();
      return invalid();
    }

    const ok = await bcrypt.compare(code, user.pinResetHash);
    if (!ok) {
      user.pinResetAttempts = (user.pinResetAttempts || 0) + 1;
      // Destroy the code rather than merely counting. A 4-digit secret cannot
      // survive unbounded guessing, and a lockout that only delays is not a
      // lockout.
      if (user.pinResetAttempts >= RESET_MAX_ATTEMPTS) clearReset(user);
      await user.save();
      return invalid();
    }

    // setPin writes BOTH pinHash and passwordHash — see the method on the
    // model. Writing only pinHash would leave checkPassword() accepting the
    // OLD pin, so the reset would appear to succeed while the previous
    // credential still logged in.
    await user.setPin(pin);
    clearReset(user);
    user.pinResetRequests = [];
    await user.save();

    // Log them straight in. They just proved control of the inbox and set a
    // fresh credential; a second login prompt is friction for no security.
    const token = signToken(user._id);
    return res.json({ token, user: user.toPublic() });
  } catch (err) {
    console.error('resetPin error', err);
    return res.status(500).json({ error: 'Could not reset PIN' });
  }
}

// Change the PIN from Settings. Requires the CURRENT pin — the JWT proves the
// session, not the person. A stolen unlocked phone shouldn't be able to lock
// the owner out.
export async function changePin(req, res) {
  try {
    const currentPin = String(req.body.currentPin || '').trim();
    const newPin = String(req.body.newPin || '').trim();

    if (!/^\d{4}$/.test(newPin)) return res.status(400).json({ error: 'PIN must be 4 digits' });
    if (currentPin === newPin) return res.status(400).json({ error: 'New PIN must be different' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await user.checkPin(currentPin);
    if (!ok) return res.status(401).json({ error: 'Current PIN is incorrect' });

    // setPin writes BOTH pinHash and passwordHash — see the method on the
    // model. Writing only pinHash would leave checkPassword() accepting the
    // OLD pin.
    await user.setPin(newPin);

    // validateBeforeSave: legacy documents carry invalid enum values (e.g.
    // gender: 'man'), and Mongoose validates the whole document on save, not
    // just the changed paths. A PIN change has no business validating gender.
    await user.save({ validateBeforeSave: false });

    return res.json({ ok: true });
  } catch (err) {
    console.error('changePin error', err);
    return res.status(500).json({ error: 'Could not change PIN' });
  }
}

export async function register(req, res) {
  try {
    const { email, pin, displayName, dob, gender } = req.body;
    let { username } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    if (!pin) {
      return res.status(400).json({ error: 'A PIN is required' });
    }
    if (!/^\d{4}$/.test(String(pin))) {
      return res.status(400).json({ error: 'PIN must be 4 digits' });
    }

    // A username may now be supplied by the signup flow; validate it. If none,
    // derive a unique one from the email local-part (padded to the 3-char min).
    if (username != null) {
      username = String(username).trim();
      if (username.length < 3 || username.length > 24) {
        return res.status(400).json({ error: 'Username must be 3 to 24 characters' });
      }
    } else {
      let base = String(email).split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || 'user';
      while (base.length < 3) base += Math.floor(Math.random() * 10);
      username = base;
      let n = 0;
      while (await User.exists({ username })) {
        n += 1;
        username = `${base}${n}`;
      }
    }

    const exists = await User.findOne({ $or: [{ email: email.toLowerCase() }, { username }] });
    if (exists) return res.status(409).json({ error: 'Username or email already in use' });

    const user = new User({ username, email, displayName: displayName || username });
    if (dob) user.dob = dob;
    if (gender) {
      user.gender = gender;
      // Seed the discovery filter from the user's own gender: female → men,
      // male → women, nonbinary/other → everyone. A default only — the user
      // can change "Show me" in settings afterward.
      user.preferences.show = defaultShowFor(gender);
    }

    // setPin writes BOTH pinHash and passwordHash — see the method on the
    // model. There is no separate password; login accepts the PIN via either
    // path. Calling setPassword here as well would be a third redundant bcrypt
    // round at cost 12 (~250ms) for the same value.
    await user.setPin(String(pin));

    user.emailVerifyToken = newVerifyToken();
    user.emailVerifyExpires = new Date(Date.now() + VERIFY_TTL_MS);
    await user.save();

    // Fire and forget. Mail failures are logged inside sendVerificationEmail;
    // the account exists and the token is returned regardless.
    sendVerificationEmail(user, user.emailVerifyToken);

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

// Clicked from the email. Returns HTML, not JSON — this opens in a browser.
export async function verifyEmail(req, res) {
  const { token } = req.params;

  const user = await User.findOne({
    emailVerifyToken: token,
    emailVerifyExpires: { $gt: new Date() },
  });

  if (!user) {
    return res.status(400).send(page('Link expired', 'This confirmation link is invalid or has expired. Request a new one from the app.'));
  }

  user.emailVerified = true;
  user.emailVerifyToken = undefined;
  user.emailVerifyExpires = undefined;
  await user.save();

  return res.send(page('Email confirmed', 'You can close this window and return to LocalPulse.'));
}

// Resend the verification email. Authenticated: the token in the request
// already proves who is asking, so there's no user enumeration to worry about.
export async function resendVerification(req, res) {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.emailVerified) return res.json({ ok: true, alreadyVerified: true });

  user.emailVerifyToken = newVerifyToken();
  user.emailVerifyExpires = new Date(Date.now() + VERIFY_TTL_MS);
  await user.save();

  sendVerificationEmail(user, user.emailVerifyToken);
  return res.json({ ok: true });
}

function page(title, body) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;
             display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center;padding:24px">
    <h1 style="font-size:22px;margin:0 0 12px">${title}</h1>
    <p style="color:#999;margin:0">${body}</p>
  </div>
</body></html>`;
}