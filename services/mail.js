// services/mail.js — Invite emails for new users.
//
// Strategy (first match wins):
//   1. SMTP — if SMTP_HOST / SMTP_USER / SMTP_PASS env vars are set (any provider,
//      e.g. Gmail App Password, Zoho, SendGrid, etc.)
//   2. Gmail API — if the acting admin has connected their Google account in
//      Settings (uses the existing gmail.send scope, sends AS that account)
//   3. Skipped — neither is available; user creation still succeeds.
//
// sendInvite() never throws — it returns 'sent' | 'failed' | 'skipped'.

const nodemailer = require('nodemailer');

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function appUrl() {
  return (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
}

function buildInviteHtml({ username, password, url }) {
  const link = url || 'https://dat-one.onrender.com';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr>
          <td style="background:#0f172a;padding:22px 28px;color:#ffffff;">
            <span style="font-size:20px;font-weight:800;">DAT <span style="color:#ff7a00;">ONE</span></span>
            <span style="display:block;font-size:11px;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Dispatch · Paperwork · Profit</span>
          </td>
        </tr>
        <tr><td style="padding:28px;color:#0f172a;font-size:14px;line-height:1.6;">
          <p style="margin:0 0 16px;">Your <b>DAT One</b> account is ready. Sign in with the credentials below:</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin:0 0 16px;">
            <tr><td style="padding:14px 18px;">
              <div style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Username</div>
              <div style="font-size:16px;font-weight:700;">${esc(username)}</div>
              <div style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-top:10px;">Default password</div>
              <div style="font-size:16px;font-weight:700;">${esc(password)}</div>
            </td></tr>
          </table>
          <p style="margin:0 0 8px;">Open the app to log in:</p>
          <p style="margin:0 0 16px;"><a href="${link}" style="background:#ff7a00;color:#ffffff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:700;display:inline-block;">Open DAT One</a></p>
          <p style="margin:0 0 16px;">App link: <a href="${link}" style="color:#ff7a00;">${link}</a></p>
          <p style="margin:0 0 16px;">You'll be asked to <b>change this password on first login</b>.</p>
          <p style="margin:0 0 16px;font-size:13px;color:#475569;">
            <b>Install as an app (optional):</b> after opening the link — on your phone, use the browser menu → <b>Add to Home Screen / Install App</b>; on desktop Chrome or Edge, click the <b>install icon</b> in the address bar.
          </p>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:14px 28px;color:#94a3b8;font-size:11px;">
          This is an automated message from DAT One — please do not reply.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildInviteSubject() {
  return 'Your DAT One account is ready';
}

// ── Password reset email (forgot-password flow) ─────────────────────────────
function buildResetHtml({ username, resetUrl }) {
  const link = resetUrl || 'https://dat-one.onrender.com';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr>
          <td style="background:#0f172a;padding:22px 28px;color:#ffffff;">
            <span style="font-size:20px;font-weight:800;">DAT <span style="color:#ff7a00;">ONE</span></span>
            <span style="display:block;font-size:11px;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Dispatch · Paperwork · Profit</span>
          </td>
        </tr>
        <tr><td style="padding:28px;color:#0f172a;font-size:14px;line-height:1.6;">
          <p style="margin:0 0 16px;">We received a request to reset the password for <b>${esc(username)}</b>. If that was you, click the button below. The link expires in <b>1 hour</b> and can only be used once.</p>
          <p style="margin:0 0 16px;"><a href="${link}" style="background:#ff7a00;color:#ffffff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:700;display:inline-block;">Set a new password</a></p>
          <p style="margin:0 0 16px;">If the button doesn't work, copy and paste this link into your browser:</p>
          <p style="margin:0 0 16px;word-break:break-all;"><a href="${link}" style="color:#ff7a00;">${link}</a></p>
          <p style="margin:0 0 16px;font-size:13px;color:#475569;">If you didn't request a password reset, you can safely ignore this email — your password stays the same.</p>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:14px 28px;color:#94a3b8;font-size:11px;">
          This is an automated message from DAT One — please do not reply.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildResetSubject() {
  return 'Reset your DAT One password';
}

// ── Username reminder email (forgot-username flow) ───────────────────────────
function buildUsernameHtml({ username }) {
  const link = appUrl() || 'https://dat-one.onrender.com';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.08);">
    <div style="font-size:22px;font-weight:900;color:#0f172a;">DAT <span style="color:#ff7a00;">ONE</span></div>
    <p style="color:#334155;font-size:15px;line-height:1.6;">You asked us to remind you of your username. Here it is:</p>
    <div style="background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;padding:16px;text-align:center;font-size:18px;font-weight:700;color:#0f172a;margin:16px 0;">${esc(username)}</div>
    <p style="color:#64748b;font-size:13px;line-height:1.5;">If you didn't request this, you can ignore this email — no changes were made to your account.</p>
    <p style="text-align:center;margin-top:20px;"><a href="${esc(link)}" style="color:#ff7a00;text-decoration:none;font-size:13px;">Go to DAT One</a></p>
    <p style="color:#94a3b8;font-size:12px;">DAT One · Dispatch · Paperwork · Profit</p>
  </div>
</body></html>`;
}

function buildUsernameSubject() {
  return 'Your DAT One username';
}

// Send via SMTP → any connected Google → skipped. Never throws.
async function sendUsername({ to, username, adminUserId }) {
  if (!to || !username) return { status: 'skipped', reason: 'no_email_or_username' };
  return sendWithStrategy({
    to,
    subject: buildUsernameSubject(),
    html: buildUsernameHtml({ username }),
    adminUserId
  });
}

// Send via SMTP (nodemailer). Throws on failure.
async function sendViaSmtp({ to, subject, html }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 15000
  });
  await transporter.sendMail({
    from: process.env.MAIL_FROM || `"DAT One" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html
  });
  return 'sent';
}

// Send via the acting user's connected Gmail (gmail.send scope). Throws on failure.
async function sendViaGmail(userId, { to, subject, html }) {
  const { google } = require('googleapis');
  const googleSvc = require('./google');
  const auth = await googleSvc.clientForUser(userId); // throws if user not connected
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = Buffer.from(
    `To: ${to}\nSubject: ${subject}\nMIME-Version: 1.0\nContent-Type: text/html; charset="utf-8"\n\n${html}`
  ).toString('base64url');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return 'sent';
}

// Find any user in the DB who has connected Google (most recently updated first)
// — used as a fallback sender when the acting admin has no connection.
async function anyConnectedUserId() {
  try {
    const { getDb } = require('../db');
    const row = await getDb().get(
      `SELECT ui.user_id FROM user_integrations ui
       WHERE ui.provider = 'google' AND ui.refresh_token IS NOT NULL
       ORDER BY ui.updated_at DESC LIMIT 1`
    );
    return row ? row.user_id : null;
  } catch (_) { return null; }
}

/**
 * Core send strategy (first match wins), shared by invites and password resets:
 *   1. SMTP — if SMTP_HOST / SMTP_USER / SMTP_PASS env vars are set
 *   2. Gmail API — via the acting admin, then ANY connected user (gmail.send scope)
 *   3. Skipped — neither is available
 * Never throws — returns { status: 'sent' | 'failed' | 'skipped', reason }.
 */
async function sendWithStrategy({ to, subject, html, adminUserId }) {
  if (smtpConfigured()) {
    try { return { status: await sendViaSmtp({ to, subject, html }), reason: 'smtp' }; }
    catch (e) { console.error('[Mail] SMTP failed:', e.message); }
  }

  const candidates = [];
  if (adminUserId) candidates.push(adminUserId);
  const fallback = await anyConnectedUserId();
  if (fallback && !candidates.includes(fallback)) candidates.push(fallback);

  for (const uid of candidates) {
    try {
      return { status: await sendViaGmail(uid, { to, subject, html }), reason: `gmail_user_${uid}` };
    } catch (e) {
      console.error(`[Mail] Gmail API failed for user ${uid}:`, e.message);
    }
  }

  return smtpConfigured()
    ? { status: 'failed', reason: 'smtp_failed_no_gmail' }
    : { status: 'skipped', reason: 'no_smtp_no_gmail' };
}

/**
 * Send a new-user invite.
 * @param {object} opts { to, username, password, adminUserId }
 * @returns {Promise<{status:'sent'|'failed'|'skipped', reason:string}>}
 */
async function sendInvite({ to, username, password, adminUserId }) {
  if (!to || !username || !password) return { status: 'skipped', reason: 'no_email_or_creds' };
  return sendWithStrategy({
    to,
    subject: buildInviteSubject(),
    html: buildInviteHtml({ username, password, url: appUrl() }),
    adminUserId
  });
}

/**
 * Send a password-reset email.
 * @param {object} opts { to, username, resetUrl, adminUserId }
 * @returns {Promise<{status:'sent'|'failed'|'skipped', reason:string}>}
 */
async function sendReset({ to, username, resetUrl, adminUserId }) {
  if (!to || !username || !resetUrl) return { status: 'skipped', reason: 'no_email_or_creds' };
  return sendWithStrategy({
    to,
    subject: buildResetSubject(),
    html: buildResetHtml({ username, resetUrl }),
    adminUserId
  });
}

module.exports = {
  sendInvite, sendReset, sendUsername, smtpConfigured, appUrl,
  buildInviteHtml, buildInviteSubject, buildResetHtml, buildResetSubject,
  buildUsernameHtml, buildUsernameSubject
};
