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