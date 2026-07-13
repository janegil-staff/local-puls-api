// localpulse/server/src/lib/mail.js
//
// Transactional email via Resend. Every send is best-effort: a mail failure
// must never fail the request that triggered it. Registration in particular
// returns a token and a usable account — a bounced verification email is a
// nuisance, not a reason to 500.
import { Resend } from 'resend';
import { config } from '../config/index.js';
import User from '../models/User.js';

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

if (!resend) {
  console.warn('⚠️  RESEND_API_KEY not set — emails will be logged, not sent');
}

async function send({ to, subject, html }) {
  if (!resend) {
    console.log(`[mail:noop] to=${to} subject="${subject}"`);
    return;
  }
  try {
    await resend.emails.send({ from: config.mailFrom, to, subject, html });
  } catch (err) {
    // Log and swallow. See the note at the top of this file.
    console.error('mail send failed', err?.message ?? err);
  }
}

// VERIFY_URL_CLIENT_DOMAIN_V1 — the link must point at the marketing site
// (qup.dating), NOT the raw API host. Two reasons:
//   1. Google Safe Browsing flags bare *.ondigitalocean.app subdomains serving
//      long-hex-token paths from emails — it's the phishing signature. A link
//      whose domain matches the sending domain (noreply@qup.dating) does not.
//   2. Clicking an API endpoint dumps raw JSON at the user. The Next page at
//      /verify calls the endpoint and renders a human-readable result.
// Requires CLIENT_URL=https://qup.dating in the server env.
export function verifyUrl(token) {
  const base = (config.clientUrl || '').replace(/\/$/, '');
  return `${base}/verifyLP?token=${encodeURIComponent(token)}`;
}

export async function sendVerificationEmail(user, token) {
  const url = verifyUrl(token);
  const name = user.displayName || user.username;
  await send({
    to: user.email,
    subject: 'Confirm your email',
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h1 style="font-size:20px;margin:0 0 16px">Welcome, ${escapeHtml(name)}</h1>
        <p style="color:#444;line-height:1.5;margin:0 0 24px">
          Confirm your email address to finish setting up your LocalPulse account.
        </p>
        <a href="${url}"
           style="display:inline-block;background:#3B82C4;color:#fff;text-decoration:none;
                  padding:12px 24px;border-radius:8px;font-weight:600">
          Confirm email
        </a>
        <p style="color:#888;font-size:13px;line-height:1.5;margin:24px 0 0">
          This link expires in 24 hours. If you didn't create an account, ignore this email.
        </p>
      </div>
    `,
  });
}

export async function sendPinResetEmail(user, code) {
  const name = user.displayName || user.username;
  await send({
    to: user.email,
    subject: `${code} is your LocalPulse reset code`,
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h1 style="font-size:20px;margin:0 0 16px">Reset your PIN</h1>
        <p style="color:#444;line-height:1.5;margin:0 0 24px">
          Hi ${escapeHtml(name)} — enter this code in the app to choose a new PIN.
        </p>
        <div style="font-size:34px;font-weight:700;letter-spacing:10px;text-align:center;
                    background:#f3f4f6;border-radius:8px;padding:20px 0;margin:0 0 24px">
          ${code}
        </div>
        <p style="color:#888;font-size:13px;line-height:1.5;margin:0">
          This code expires in 10 minutes and can be used once. If you didn't ask to
          reset your PIN, someone may know your email address — you can ignore this,
          your account is unchanged.
        </p>
      </div>
    `,
  });
}

// ─── Report alerts ──────────────────────────────────────────────────────────
// Emails the admin address when a user or post is reported, so reports don't
// sit unseen in the DB. Best-effort like every other send here: a mail failure
// must never fail the report itself (moderationController calls this with
// .catch(() => {})).
//
// Enriches the alert with reporter/target usernames — a bare ObjectId email is
// useless at review time. Lookups are cheap and best-effort; if one fails the
// email still goes out with the raw id.
async function usernameFor(id) {
  if (!id) return '(unknown)';
  try {
    const u = await User.findById(id).select('username');
    return u ? `${u.username} (${id})` : String(id);
  } catch {
    return String(id);
  }
}

// kind: 'user' | 'post'. targetId is the reportedUser id or the post id.
export async function notifyReport({ kind, reason, note, reporterId, targetId }) {
  const [reporter, target] = await Promise.all([
    usernameFor(reporterId),
    usernameFor(targetId),
  ]);

  const targetLabel = kind === 'post' ? 'Reported post' : 'Reported user';
  const subject = `⚠️ ${kind === 'post' ? 'Post' : 'User'} reported: ${reason}`;

  await send({
    to: config.adminEmail,
    subject,
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h1 style="font-size:18px;margin:0 0 16px">New ${escapeHtml(kind)} report</h1>
        <table style="width:100%;border-collapse:collapse;font-size:14px;color:#222">
          <tr><td style="padding:6px 0;color:#888;width:120px">Reason</td><td style="padding:6px 0;font-weight:600">${escapeHtml(reason)}</td></tr>
          <tr><td style="padding:6px 0;color:#888">${targetLabel}</td><td style="padding:6px 0">${escapeHtml(target)}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Reporter</td><td style="padding:6px 0">${escapeHtml(reporter)}</td></tr>
          ${note ? `<tr><td style="padding:6px 0;color:#888;vertical-align:top">Note</td><td style="padding:6px 0">${escapeHtml(note)}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#888">Time</td><td style="padding:6px 0">${new Date().toISOString()}</td></tr>
        </table>
        <p style="color:#888;font-size:13px;line-height:1.5;margin:24px 0 0">
          This report is stored with status <strong>open</strong>. Review it in the
          admin reports list and mark it reviewed or dismissed.
        </p>
      </div>
    `,
  });
}

// The display name is user-controlled and lands inside an HTML text node —
// still, escape it rather than trusting maxlength.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}