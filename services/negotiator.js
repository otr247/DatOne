// services/negotiator.js — AI email negotiation bots.
//
// v1 scope: admin/dispatcher creates a campaign (lane, equipment, pickup date,
// target rate, min rate, round limit). The bot emails selected brokers an
// inquiry, watches the inbox for replies (via the OWNER's connected Google),
// and AI-drafts counter-offers. Strict guardrails:
//   • never agrees below min_rate
//   • stops after max_rounds
//   • stops when the broker accepts / closes the load
//   • every message is logged; an "agreed" thread still needs a HUMAN to book
//   • auto_send=0 → AI drafts are stored as 'draft' rows, sent manually
//
// Emails are sent FROM the campaign owner's connected Gmail (gmail.send) and
// replies are read via the same account (gmail.readonly — requires the v2.4+
// reconnect).

const { getDb } = require('../db');
const ai = require('./ai');
const google = require('./google');

const THREAD_OPEN   = 'negotiating';
const THREAD_AGREED = 'agreed';
const THREAD_CLOSED = 'closed';       // broker rejected / load gone
const THREAD_EXHAUSTED = 'exhausted'; // hit round limit, needs human
const THREAD_PENDING  = 'needs_approval'; // draft ready, auto_send off

const POLL_HOURS = 72; // look back window for replies

// ─── Pure state machine (unit-testable) ──────────────────────────────────────

function extractOffer(text) {
  const t = String(text || '').toLowerCase();
  const m = t.match(/\$\s?([0-9][0-9,]{2,})/);
  if (m) return Number(m[1].replace(/,/g, ''));
  const m2 = t.match(/([0-9][0-9,]{3,})\s?(?:all[- ]in|total|flat|offer)/);
  if (m2) return Number(m2[1].replace(/,/g, ''));
  return null;
}

/**
 * Decide how to respond to a broker reply.
 * @param {object} s { replyText, minRate, targetRate, round, maxRounds }
 * @returns {{action:'accept'|'counter'|'end', reason:string, offer?:number|null}}
 */
function decideNextAction(s) {
  const t = String(s.replyText || '').toLowerCase();
  const minRate = Number(s.minRate) || 0;
  const targetRate = Number(s.targetRate) || minRate;
  const round = Number(s.round) || 0;
  const maxRounds = Number(s.maxRounds) || 3;

  const closed = /\b(no longer available|already booked|filled|canceled|cancelled|not available|no coverage|not interested|no longer needed|awarded to another)\b/.test(t);
  if (closed) return { action: 'end', reason: 'broker_closed' };

  const acceptance = /\b(book it|booked|confirmed|done deal|you got it|we accept|accept(ed)?|agreed|let'?s do it|we have a deal|locked in|go ahead|sending rate con)\b/.test(t);
  const offer = extractOffer(t);

  if (acceptance) return { action: 'accept', reason: 'acceptance_language', offer };
  if (offer !== null && offer >= targetRate) return { action: 'accept', reason: `offer ${offer} >= target ${targetRate}`, offer };
  if (offer !== null && offer >= minRate) return { action: 'accept', reason: `offer ${offer} >= floor ${minRate}`, offer };
  if (round >= maxRounds) return { action: 'end', reason: 'max_rounds', offer };
  return { action: 'counter', reason: offer !== null ? `offer ${offer} below floor ${minRate}` : 'no_rate_in_reply', offer };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function htmlBody(text) {
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;">${
    String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  }</div>`;
}

function campaignSubject(c) {
  return `Load Inquiry: ${c.origin || '?'} → ${c.destination || '?'}${c.equipment ? ` (${c.equipment})` : ''}`;
}

async function logMessage(threadId, direction, subject, body, gmailMsgId) {
  await getDb().run(
    `INSERT INTO negotiation_messages (thread_id, direction, subject, body, gmail_msg_id) VALUES (?,?,?,?,?)`,
    [threadId, direction, subject || '', body || '', gmailMsgId || null]
  );
}

async function updateThread(threadId, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(fields);
  await getDb().run(
    `UPDATE negotiation_threads SET ${sets}, updated_at = datetime('now') WHERE id = ?`,
    [...vals, threadId]
  );
}

// ─── Drafting ────────────────────────────────────────────────────────────────

async function draftInitial(c) {
  return ai.draft({
    kind: 'inquiry', broker: '', origin: c.origin, destination: c.destination,
    rate: c.target_rate, notes: c.equipment ? `Equipment: ${c.equipment}` : ''
  });
}

async function draftCounter(c, thread, replyText) {
  const ask = Math.max(Number(c.min_rate) || 0, Math.round((Number(c.target_rate) || 0) * 0.9));
  return ai.draft({
    kind: 'negotiate', broker: thread.broker_name || thread.broker_email,
    origin: c.origin, destination: c.destination, rate: ask || c.target_rate,
    notes: `Broker reply: ${(replyText || '').slice(0, 400)}`
  });
}

async function draftAccept(c, thread, offer) {
  return ai.draft({
    kind: 'book', broker: thread.broker_name || thread.broker_email,
    origin: c.origin, destination: c.destination, rate: offer || c.target_rate
  });
}

// ─── Sending ─────────────────────────────────────────────────────────────────

async function sendEmail(ownerId, thread, subject, body) {
  const sent = await google.gmailSend(ownerId, {
    to: thread.broker_email, subject, html: htmlBody(body)
  });
  await logMessage(thread.id, 'out', subject, body, sent.id);
  if (sent.threadId) await updateThread(thread.id, { gmail_thread_id: sent.threadId });
  return sent;
}

// ─── Campaign lifecycle ──────────────────────────────────────────────────────

async function createCampaign(ownerId, data, brokerIds) {
  // Owner must have Google connected (send + read)
  const status = await google.userStatus(ownerId);
  if (!status.connected) throw new Error('Connect Google in Settings first (the bot sends and reads email as you)');

  const info = await getDb().run(
    `INSERT INTO negotiation_campaigns
       (owner_id, name, origin, destination, equipment, pickup_date, target_rate, min_rate, max_rounds, auto_send, status)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'active')`,
    [ownerId, data.name || 'Campaign', data.origin || '', data.destination || '', data.equipment || '',
     data.pickup_date || null, data.target_rate ? Number(data.target_rate) : null,
     data.min_rate ? Number(data.min_rate) : null, Math.min(Math.max(Number(data.max_rounds) || 3, 1), 6),
     data.auto_send === false || data.auto_send === 0 ? 0 : 1]
  );
  const campaignId = info.lastID;

  let brokers = [];
  if (Array.isArray(brokerIds) && brokerIds.length) {
    brokers = await getDb().all(
      `SELECT * FROM contacts WHERE owner_id = ? AND type = 'broker' AND id IN (${brokerIds.map(() => '?').join(',')}) AND email IS NOT NULL AND email != ''`,
      [ownerId, ...brokerIds]
    );
  } else {
    brokers = await getDb().all(
      `SELECT * FROM contacts WHERE owner_id = ? AND type = 'broker' AND email IS NOT NULL AND email != ''`,
      [ownerId]
    );
  }

  if (!brokers.length) {
    await getDb().run('DELETE FROM negotiation_campaigns WHERE id = ?', [campaignId]);
    throw new Error('No brokers with email addresses found — add broker contacts (with emails) first');
  }

  const campaign = await getDb().get('SELECT * FROM negotiation_campaigns WHERE id = ?', [campaignId]);
  const subject = campaignSubject(campaign);
  const body = await draftInitial(campaign);

  for (const b of brokers) {
    const th = await getDb().run(
      `INSERT INTO negotiation_threads (campaign_id, broker_contact_id, broker_email, broker_name, status) VALUES (?,?,?,?,?)`,
      [campaignId, b.id, b.email, b.name || b.company || '']
    );
    const thread = await getDb().get('SELECT * FROM negotiation_threads WHERE id = ?', [th.lastID]);
    try {
      const sent = await sendEmail(ownerId, thread, subject, body);
      await updateThread(thread.id, { round: 1, last_email_id: sent.id, gmail_thread_id: sent.threadId || thread.gmail_thread_id });
    } catch (e) {
      console.error(`[Negotiator] initial send to ${b.email} failed:`, e.message);
      await updateThread(thread.id, { status: THREAD_CLOSED, summary: `Initial email failed: ${e.message}` });
    }
  }
  return campaignId;
}

// ─── Polling (replies → AI decision → reply) ─────────────────────────────────

async function pollCampaigns() {
  const campaigns = await getDb().all(
    `SELECT * FROM negotiation_campaigns WHERE status = 'active'`
  );
  for (const c of campaigns) {
    await pollCampaign(c);
  }
}

async function pollCampaign(c) {
  const threads = await getDb().all(
    `SELECT * FROM negotiation_threads WHERE campaign_id = ? AND status IN ('negotiating','needs_approval')`,
    [c.id]
  );
  for (const thread of threads) {
    await processThread(c, thread);
  }
}

async function processThread(c, thread) {
  try {
    // Find unseen replies from this broker in the owner's inbox
    const seen = new Set();
    const msgs = await getDb().all(
      `SELECT gmail_msg_id FROM negotiation_messages WHERE thread_id = ? AND gmail_msg_id IS NOT NULL`,
      [thread.id]
    );
    msgs.forEach(m => seen.add(m.gmail_msg_id));

    const q = `from:${thread.broker_email} in:inbox newer_than:${POLL_HOURS}h`;
    const incoming = await google.gmailSearchMessages(c.owner_id, q, 25);

    let newestReply = null;
    for (const m of incoming) {
      if (!seen.has(m.id)) { newestReply = m; }
    }
    if (!newestReply) return; // nothing new

    await logMessage(thread.id, 'in', newestReply.subject, newestReply.snippet + '\n' + newestReply.bodyText, newestReply.id);
    await updateThread(thread.id, {
      gmail_thread_id: newestReply.threadId || thread.gmail_thread_id,
      last_email_id: newestReply.id,
      last_reply_at: newestReply.date || new Date().toISOString()
    });

    const decision = decideNextAction({
      replyText: newestReply.snippet + ' ' + newestReply.bodyText,
      minRate: c.min_rate, targetRate: c.target_rate,
      round: thread.round, maxRounds: c.max_rounds
    });

    if (decision.action === 'accept') {
      const body = await draftAccept(c, thread, decision.offer);
      const subject = (newestReply.subject || '').replace(/^re:\s*/i, '') || campaignSubject(c);
      if (c.auto_send) {
        await sendEmail(c.owner_id, thread, subject, body);
        await updateThread(thread.id, { status: THREAD_AGREED, summary: `Agreed${decision.offer ? ` at $${decision.offer}` : ''} — ready to book (human action)` });
      } else {
        await logMessage(thread.id, 'draft', subject, body);
        await updateThread(thread.id, { status: THREAD_PENDING, summary: `Agreement draft ready (auto_send off) — approve to send` });
      }
      return;
    }

    if (decision.action === 'end') {
      const status = decision.reason === 'max_rounds' ? THREAD_EXHAUSTED : THREAD_CLOSED;
      await updateThread(thread.id, { status, summary: `Stopped: ${decision.reason}` });
      return;
    }

    // counter
    const nextRound = (thread.round || 1) + 1;
    const body = await draftCounter(c, thread, newestReply.bodyText || newestReply.snippet);
    const subject = (newestReply.subject || '').replace(/^re:\s*/i, '') || campaignSubject(c);
    if (c.auto_send && nextRound <= c.max_rounds) {
      await sendEmail(c.owner_id, thread, subject, body);
      await updateThread(thread.id, { round: nextRound, summary: `Round ${nextRound}: counter sent` });
    } else if (c.auto_send && nextRound > c.max_rounds) {
      await logMessage(thread.id, 'draft', subject, body);
      await updateThread(thread.id, { status: THREAD_EXHAUSTED, summary: `Max rounds reached — draft saved, human review` });
    } else {
      await logMessage(thread.id, 'draft', subject, body);
      await updateThread(thread.id, { status: THREAD_PENDING, summary: `Draft ready (auto_send off) — approve to send` });
    }
  } catch (e) {
    console.error(`[Negotiator] thread ${thread.id} error:`, e.message);
    await updateThread(thread.id, { status: THREAD_CLOSED, summary: `Bot error: ${e.message}` });
  }
}

// ─── Manual approve/send of a pending draft ──────────────────────────────────

async function approvePendingDraft(ownerId, threadId) {
  const thread = await getDb().get(
    `SELECT t.*, c.* FROM negotiation_threads t JOIN negotiation_campaigns c ON c.id = t.campaign_id WHERE t.id = ? AND c.owner_id = ?`,
    [threadId, ownerId]
  );
  if (!thread) throw new Error('Thread not found');
  const draft = await getDb().get(
    `SELECT * FROM negotiation_messages WHERE thread_id = ? AND direction = 'draft' ORDER BY id DESC LIMIT 1`,
    [threadId]
  );
  if (!draft) throw new Error('No pending draft for this thread');
  const sent = await google.gmailSend(ownerId, {
    to: thread.broker_email, subject: draft.subject, html: htmlBody(draft.body), threadId: thread.gmail_thread_id
  });
  await getDb().run(
    `UPDATE negotiation_messages SET direction = 'out', gmail_msg_id = ? WHERE id = ?`,
    [sent.id, draft.id]
  );
  const newRound = (thread.round || 1) + 1;
  await updateThread(threadId, {
    round: newRound, gmail_thread_id: sent.threadId || thread.gmail_thread_id,
    status: newRound > thread.max_rounds ? THREAD_EXHAUSTED : THREAD_OPEN,
    summary: `Draft approved & sent (round ${newRound})`
  });
  return sent;
}

module.exports = {
  createCampaign,
  pollCampaigns,
  approvePendingDraft,
  decideNextAction,
  extractOffer,
  THREAD_OPEN, THREAD_AGREED, THREAD_CLOSED, THREAD_EXHAUSTED, THREAD_PENDING
};
