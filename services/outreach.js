// services/outreach.js — AI broker outreach straight from DAT load board listings.
//
// v2.6: one-click "Email Broker" on any DAT row. The AI composes an inquiry
// (services/ai.js — OpenAI-compatible with template fallback) from the load
// details + reference number, sends it FROM the owner's connected Gmail, and
// logs it to dat_outreach. Replies are picked up by pollReplies() (run on a
// timer, same pattern as the negotiation bots).
//
// Guardrails:
//   • Never throws — always returns { ok, status, reason } so the API stays up
//   • Owner-scoped: rows are keyed to owner_id, list is filtered server-side
//   • Gracefully fails when Google isn't connected or no email is on the post

const { getDb } = require('../db');
const ai = require('./ai');
const google = require('./google');

const POLL_HOURS = 72; // look-back window for broker replies

function htmlBody(text) {
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;">${
    String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  }</div>`;
}

function outreachSubject(load) {
  const lane = [load.origin, load.destination].filter(Boolean).join(' → ');
  const parts = ['Load Inquiry'];
  if (lane) parts.push(lane);
  if (load.equipment) parts.push(`(${load.equipment})`);
  if (load.ref) parts.push(`— ${load.ref}`);
  return parts.join(' ');
}

// Compose + send an AI inquiry to the broker on a DAT listing.
//   load    = the normalized DAT load object from the board (id/ref/broker/
//             broker_email/contact/extension/origin/destination/equipment/
//             miles/rate/comments)
//   subject = optional override (otherwise AI-generated)
//   body    = optional override (otherwise AI-generated; the UI lets the
//             user edit the draft before sending)
async function emailBrokerFromLoad({ ownerId, load, subject, body }) {
  try {
    if (!ownerId) return { ok: false, status: 'failed', reason: 'no_user' };
    const email = String((load && load.broker_email) || '').trim();
    if (!email) {
      return { ok: false, status: 'failed', reason: 'no_email',
        message: 'No broker email on this posting — try the AI voice call instead.' };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, status: 'failed', reason: 'invalid_email', message: 'The email on this posting looks invalid.' };
    }

    // Owner must have Google connected — gmailSend throws otherwise
    const status = await google.userStatus(ownerId);
    if (!status.connected) {
      return { ok: false, status: 'failed', reason: 'no_google',
        message: 'Connect Google in Settings first — the AI sends as you.' };
    }

    const broker = (load.broker || '').trim() || email;
    const notes = [
      load.equipment ? `Equipment: ${load.equipment}` : '',
      load.miles ? `Miles: ${load.miles}` : '',
      load.comments ? `Posting comments: ${String(load.comments).slice(0, 300)}` : ''
    ].filter(Boolean).join('\n');

    const finalBody = (body && String(body).trim())
      ? String(body).trim()
      : await ai.draft({
          kind: 'inquiry',
          broker,
          origin: load.origin,
          destination: load.destination,
          rate: load.rate,
          ref: load.ref,
          notes
        });

    const finalSubject = (subject && String(subject).trim()) ? String(subject).trim() : outreachSubject(load);
    const sent = await google.gmailSend(ownerId, { to: email, subject: finalSubject, html: htmlBody(finalBody) });

    const lane = [load.origin, load.destination].filter(Boolean).join(' → ');
    const info = await getDb().run(
      `INSERT INTO dat_outreach
         (owner_id, dat_load_id, broker_name, broker_email, broker_phone, ref_number, lane,
          direction, subject, body, status, gmail_thread_id, gmail_msg_id)
       VALUES (?,?,?,?,?,?,?, 'out', ?, ?, 'sent', ?, ?)`,
      [ownerId, String(load.id || ''), broker, email, String(load.contact || ''),
       String(load.ref || ''), lane, finalSubject, finalBody,
       sent.threadId || null, sent.id || null]
    );

    return { ok: true, status: 'sent', id: info.lastID, threadId: sent.threadId || null, email };
  } catch (e) {
    console.error('[Outreach] send failed:', e.message);
    return { ok: false, status: 'failed', reason: 'send_error', message: e.message };
  }
}

// Look for broker replies in the owner's inbox and mark rows as 'replied'.
async function pollReplies(ownerId) {
  if (!ownerId) return { ok: false, reason: 'no_user' };
  const rows = await getDb().all(
    `SELECT * FROM dat_outreach WHERE owner_id = ? AND status = 'sent' AND broker_email IS NOT NULL AND broker_email != ''`,
    [ownerId]
  );
  let found = 0;
  for (const row of rows) {
    try {
      const q = `from:${row.broker_email} in:inbox newer_than:${POLL_HOURS}h`;
      const msgs = await google.gmailSearchMessages(ownerId, q, 10);
      if (!msgs.length) continue;
      const newest = msgs[0];
      await getDb().run(
        `UPDATE dat_outreach SET status = 'replied', reply_snippet = ?, gmail_thread_id = COALESCE(?, gmail_thread_id),
           updated_at = datetime('now') WHERE id = ? AND owner_id = ?`,
        [String(newest.snippet || '').slice(0, 500), newest.threadId || null, row.id, ownerId]
      );
      found++;
    } catch (e) {
      console.error(`[Outreach] poll reply for row ${row.id}:`, e.message);
    }
  }
  return { ok: true, found };
}

async function listOutreach(ownerId) {
  return await getDb().all(
    `SELECT * FROM dat_outreach WHERE owner_id = ? ORDER BY id DESC LIMIT 200`,
    [ownerId]
  );
}

module.exports = { emailBrokerFromLoad, pollReplies, listOutreach };
