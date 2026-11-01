#!/usr/bin/env bash
# fix-api.sh
#
# Email verification fix for the API (local-puls-api): verifyEmail works for
# older accounts, Resend errors are logged, emails get a plain-text version and
# say "Qup Pulse" instead of "LocalPulse".
#
# Usage (any of these):
#   bash fix-api.sh /path/to/local-puls-api
#   cd /path/to/local-puls-api && bash ~/Downloads/fix-api.sh
#   bash fix-api.sh --commit /path/to/local-puls-api     # also git add/commit/push
#
# Without a path it uses the current folder if it is local-puls-api, otherwise it
# asks (you can drag the folder in from Finder).
# Nothing is changed if the fix does not apply cleanly.

set -euo pipefail

PROJ="local-puls-api"
COMMIT_MSG="Fix email verification, log Resend errors, plain-text emails"
MARKER=""

COMMIT=0
if [[ "${1:-}" == "--commit" ]]; then COMMIT=1; shift; fi
DIR="${1:-}"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

if [[ -z "$DIR" ]]; then
  if [[ -f package.json ]] && grep -q "\"name\": *\"local-pulse-api\"" package.json; then
    DIR="$PWD"
  else
    read -r -p "Path to $PROJ (drag the folder here): " DIR
    # Finder drag-and-drop adds a trailing space and escapes spaces with "\ "
    DIR="${DIR%"${DIR##*[![:space:]]}"}"
    DIR="${DIR//\\ / }"
    DIR="${DIR/#\~/$HOME}"
  fi
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PATCH="$TMP/fix.patch"

cat > "$PATCH" <<'__PATCH_END__'
diff --git a/src/controllers/authController.js b/src/controllers/authController.js
index 13beb23..a372d31 100644
--- a/src/controllers/authController.js
+++ b/src/controllers/authController.js
@@ -319,12 +319,15 @@ export async function verifyEmail(req, res) {
   user.emailVerified = true;
   user.emailVerifyToken = undefined;
   user.emailVerifyExpires = undefined;
-  await user.save(); // in login, register, and GET /api/me
-  res.json({
-    token,
-    user: user.toPublic(),
-    ...user.profileState(), // { profileComplete, missingProfileFields }
-  });
+  // validateBeforeSave: false — same reason as changePin. Legacy documents
+  // carry invalid enum values (e.g. gender: 'man'); a full-document validation
+  // would 500 here and the user would never get verified.
+  await user.save({ validateBeforeSave: false });
+
+  // The web page at /verifyLP only checks res.ok. Don't echo the user or the
+  // (now spent) verify token: this endpoint is unauthenticated, and anyone
+  // holding a forwarded link shouldn't get profile data back.
+  return res.json({ ok: true, emailVerified: true });
 }
 
 // Resend the verification email. Authenticated: the token in the request
diff --git a/src/lib/mail.js b/src/lib/mail.js
index 6a0c7bc..972e564 100644
--- a/src/lib/mail.js
+++ b/src/lib/mail.js
@@ -14,27 +14,43 @@ if (!resend) {
   console.warn('⚠️  RESEND_API_KEY not set — emails will be logged, not sent');
 }
 
-async function send({ to, subject, html }) {
+async function send({ to, subject, html, text }) {
   if (!resend) {
     console.log(`[mail:noop] to=${to} subject="${subject}"`);
     return;
   }
   try {
-    await resend.emails.send({ from: config.mailFrom, to, subject, html });
+    // The Resend SDK does NOT throw on API errors (unverified domain, bad
+    // key, invalid "from"). It resolves with { data, error }. Checking only
+    // for a throw meant every rejected send vanished without a log line.
+    const { data, error } = await resend.emails.send({
+      from: config.mailFrom, to, subject, html,
+      // A plain-text part alongside the HTML: HTML-only mail scores worse
+      // with spam filters (iCloud in particular).
+      ...(text ? { text } : {}),
+    });
+    if (error) {
+      console.error(
+        `mail send rejected from="${config.mailFrom}" to=${to}:`,
+        error.name ?? '', error.message ?? error,
+      );
+      return;
+    }
+    console.log(`[mail] sent id=${data?.id} to=${to} subject="${subject}"`);
   } catch (err) {
-    // Log and swallow. See the note at the top of this file.
+    // Network failure etc. Log and swallow. See the note at the top of this file.
     console.error('mail send failed', err?.message ?? err);
   }
 }
 
 // VERIFY_URL_CLIENT_DOMAIN_V1 — the link must point at the marketing site
-// (qup.dating), NOT the raw API host. Two reasons:
+// (quppulse.com), NOT the raw API host. Two reasons:
 //   1. Google Safe Browsing flags bare *.ondigitalocean.app subdomains serving
 //      long-hex-token paths from emails — it's the phishing signature. A link
-//      whose domain matches the sending domain (noreply@qup.dating) does not.
+//      whose domain matches the sending domain (noreply@quppulse.com) does not.
 //   2. Clicking an API endpoint dumps raw JSON at the user. The Next page at
-//      /verify calls the endpoint and renders a human-readable result.
-// Requires CLIENT_URL=https://qup.dating in the server env.
+//      /verifyLP (qup-pulse-admin) calls the endpoint and renders a human-readable result.
+// Requires CLIENT_URL=https://quppulse.com in the server env.
 export function verifyUrl(token) {
   const base = (config.clientUrl || '').replace(/\/$/, '');
   return `${base}/verifyLP?token=${encodeURIComponent(token)}`;
@@ -45,12 +61,13 @@ export async function sendVerificationEmail(user, token) {
   const name = user.displayName || user.username;
   await send({
     to: user.email,
-    subject: 'Confirm your email',
+    subject: 'Confirm your email for Qup Pulse',
+    text: `Welcome, ${name}\n\nConfirm your email address to finish setting up your Qup Pulse account:\n${url}\n\nThis link expires in 24 hours. If you didn't create an account, ignore this email.\n`,
     html: `
       <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
         <h1 style="font-size:20px;margin:0 0 16px">Welcome, ${escapeHtml(name)}</h1>
         <p style="color:#444;line-height:1.5;margin:0 0 24px">
-          Confirm your email address to finish setting up your LocalPulse account.
+          Confirm your email address to finish setting up your Qup Pulse account.
         </p>
         <a href="${url}"
            style="display:inline-block;background:#3B82C4;color:#fff;text-decoration:none;
@@ -69,7 +86,8 @@ export async function sendPinResetEmail(user, code) {
   const name = user.displayName || user.username;
   await send({
     to: user.email,
-    subject: `${code} is your LocalPulse reset code`,
+    subject: `${code} is your Qup Pulse reset code`,
+    text: `Reset your PIN\n\nHi ${name} — enter this code in the app to choose a new PIN: ${code}\n\nThis code expires in 10 minutes and can be used once. If you didn't ask to reset your PIN, you can ignore this email; your account is unchanged.\n`,
     html: `
       <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
         <h1 style="font-size:20px;margin:0 0 16px">Reset your PIN</h1>
__PATCH_END__

bold "== $PROJ: $DIR"
[[ -d "$DIR" ]] || { red "Folder not found: $DIR"; exit 1; }
git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { red "Not a git repository: $DIR"; exit 1; }
[[ -f "$DIR/package.json" ]] || { red "No package.json in $DIR. Is this the right folder?"; exit 1; }
grep -q "\"name\": *\"local-pulse-api\"" "$DIR/package.json" || {
  red "package.json in $DIR is not local-pulse-api. Wrong folder?"; exit 1; }

if git -C "$DIR" apply --reverse --check "$PATCH" >/dev/null 2>&1; then
  green "Already applied, nothing to do."
elif git -C "$DIR" apply --check "$PATCH" 2>"$TMP/err"; then
  git -C "$DIR" apply "$PATCH"
  green "Applied."
else
  red "The fix does not apply cleanly. Nothing was changed."
  sed 's/^/   /' "$TMP/err"
  echo "   Usually this means the files changed since the zip you sent, or an"
  echo "   older version of the fix is applied. Check with: git -C \"$DIR\" diff"
  exit 1
fi

[[ -z "$MARKER" || -e "$DIR/$MARKER" ]] || { red "Expected $MARKER after applying"; exit 1; }
git -C "$DIR" status --short

if [[ $COMMIT -eq 1 ]]; then
  git -C "$DIR" add -A
  if git -C "$DIR" diff --cached --quiet; then
    echo "Nothing to commit."
  else
    git -C "$DIR" commit -m "$COMMIT_MSG"
    git -C "$DIR" push
    green "Committed and pushed."
  fi
fi

echo
bold "Done. Next steps:"
[[ $COMMIT -eq 0 ]] && echo "  - git add -A && git commit -m \"$COMMIT_MSG\" && git push  (or rerun with --commit)"
echo "  - DigitalOcean, API env vars: CLIENT_URL=https://quppulse.com"
echo "                                MAIL_FROM=Qup Pulse <noreply@qup-pro.com>"
echo "  - Register a test user and check that the link starts with CLIENT_URL"
