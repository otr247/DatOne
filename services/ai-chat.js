// services/ai-chat.js — AI Fleet Assistant (chat + persistent preferences).
//
// v3.4: users chat with the AI to teach it their fleet: truck MC numbers per
// area, preferred rates, weight/length limits, dates, times — per truck,
// driver, owner, dispatcher, or the whole operation. Extracted preferences are
// stored per-owner in ai_prefs and injected into voice calls (buildSystemPrompt
// gets a FLEET PREFERENCES section) so the AI negotiates with the right numbers.
//
// Extraction protocol: when the user provides preference info, the model ends
// its reply with a line `PREFS_JSON: {…}` containing the new/updated keys; the
// server parses it, merges into ai_prefs, and strips the line from the reply.
// Without an API key, a light regex extractor saves simple patterns (MC, $/mi,
// weight, length, city) so the feature still works.

const { getDb } = require('../db');
const ai = require('./ai'); // shared OpenAI-compatible helper w/ model fallback

function isConfigured() { return !!process.env.OPENAI_API_KEY; }

async function getPrefs(ownerId) {
  const row = await getDb().get('SELECT prefs FROM ai_prefs WHERE owner_id = ?', ownerId).catch(() => null);
  try { return row && row.prefs ? JSON.parse(row.prefs) : {}; } catch (_) { return {}; }
}

async function savePrefs(ownerId, prefs) {
  const text = JSON.stringify(prefs || {});
  await getDb().run(
    `INSERT INTO ai_prefs (owner_id, prefs, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(owner_id) DO UPDATE SET prefs = excluded.prefs, updated_at = datetime('now')`,
    [ownerId, text]
  );
}

async function removePref(ownerId, key) {
  const prefs = await getPrefs(ownerId);
  if (key && key in prefs) { delete prefs[key]; await savePrefs(ownerId, prefs); }
  return prefs;
}

async function history(ownerId, limit = 100) {
  return await getDb().all(
    'SELECT id, role, content, created_at FROM ai_chat WHERE owner_id = ? ORDER BY id DESC LIMIT ?',
    [ownerId, limit]
  );
}

async function addMsg(ownerId, role, content) {
  const info = await getDb().run(
    'INSERT INTO ai_chat (owner_id, role, content) VALUES (?,?,?)',
    [ownerId, role, String(content || '').slice(0, 4000)]
  );
  return info.lastID;
}

const SYSTEM_PROMPT = `You are the AI fleet assistant for a US freight dispatch company (DAT One). You talk like a helpful, experienced dispatcher's right hand.
- Keep replies short (2-4 sentences) and practical.
- You help with fleet setup: truck MC numbers (per area/truck), preferred rates (per mile or per load), weight and length limits, preferred dates/times, and the owner's or dispatcher's preferences.
- Whenever the user GIVES you preference info (anything about MCs, rates, weights, lengths, dates, times, equipment, drivers, or areas), acknowledge it briefly and then output one final line exactly like this — with ONLY the preference keys you learned or updated, as a flat JSON object:
PREFS_JSON: {"truck_7_mc": "123456", "chicago_rate_per_mile": 2.1}
- Use clear flat keys (e.g. "mc_truck_7", "rate_per_mile", "max_weight_lbs", "max_length_ft", "driver_<name>_rate"). Keep values as strings/numbers.
- If asked how the app uses this: it remembers fleet preferences and uses them on AI voice calls and when booking loads.
- Never invent an MC number or rate — only store what the user tells you.`;

function extractPrefsFromReply(reply) {
  // PREFS_JSON can appear at the start or after a short lead-in — find it
  // anywhere, parse the trailing JSON object, and strip it from the shown reply.
  const m = String(reply || '').match(/PREFS_JSON:\s*(\{[\s\S]*?\})\s*$/m);
  if (!m) return { prefs: null, clean: reply };
  try {
    const prefs = JSON.parse(m[1]);
    return { prefs, clean: reply.replace(m[0], '').trim() };
  } catch (_) { return { prefs: null, clean: reply }; }
}

async function callOpenAI(messages) {
  // Shared helper: host-aware base URL + model fallback (see services/ai.js)
  return await ai.chatCompletion([
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages
  ], 0.7);
}

// Light offline extraction when no API key is configured
function regexExtractPrefs(text) {
  const prefs = {};
  const mc = String(text || '').match(/\bMC\s*(?:#|number|no\.?|is)?\s*[:#]?\s*(\d{4,7})\b/i);
  if (mc) prefs.mc_number = mc[1];
  const rpm = String(text || '').match(/\$\s?([\d.]+)\s*\/?\s*(?:mi|mile|per mile)/i);
  if (rpm) prefs.rate_per_mile = Number(rpm[1]);
  const lbs = String(text || '').match(/(\d{4,5})\s*(?:lbs?|pounds)\b/i);
  if (lbs) prefs.max_weight_lbs = Number(lbs[1]);
  const ft = String(text || '').match(/(\d{2,3})\s*(?:ft|feet|foot)\b/i);
  if (ft) prefs.max_length_ft = Number(ft[1]);
  const city = String(text || '').match(/\bfor\s+the\s+([A-Z][a-zA-Z .]+?)(?:\s+area|\s+region|,|\.|$)/);
  if (city) prefs.area = city[1].trim();
  return Object.keys(prefs).length ? prefs : null;
}

// Main chat entry. Returns { reply, prefs } (prefs = the updated full prefs).
async function chat(ownerId, message) {
  const text = String(message || '').trim();
  if (!text) return { reply: 'Say something — e.g. "Truck 7 MC is 123456, preferred rate $2.10/mile".' };
  await addMsg(ownerId, 'user', text);

  let current = await getPrefs(ownerId);
  let reply;
  let extracted = null;
  const prior = await history(ownerId, 8);

  if (isConfigured()) {
    try {
      const msgs = prior.slice().reverse().map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
      msgs.push({ role: 'user', content: text });
      const raw = await callOpenAI(msgs);
      const res = extractPrefsFromReply(raw);
      reply = res.clean || raw;
      extracted = res.prefs;
    } catch (e) {
      reply = `I hit a hiccup reaching the AI (${e.message}) — I've noted your message anyway.`;
    }
  } else {
    // No API key — save what we can parse, reply helpfully
    const hasPrefsHint = /mc\b|rate|mile|lbs|pounds|ft\b|feet|area|prefer/i.test(text);
    extracted = regexExtractPrefs(text);
    reply = hasPrefsHint
      ? (extracted ? "Got it — I've saved what I could parse (MC, rates, limits, area). For full AI chat, add OPENAI_API_KEY on Render." : 'Noted. For full understanding, add OPENAI_API_KEY on Render — meanwhile I saved anything I could parse.')
      : `I'm here to remember your fleet setup — tell me things like "Truck 7's MC is 123456, preferred rate $2.10/mile, max 44,000 lbs for the Chicago area". (For full AI chat, add OPENAI_API_KEY on Render.)`;
  }

  if (extracted && Object.keys(extracted).length) {
    const merged = { ...current, ...extracted };
    await savePrefs(ownerId, merged);
    current = merged;
  }
  await addMsg(ownerId, 'assistant', reply);
  return { reply, prefs: current };
}

// Compact, readable summary of the owner's prefs for the voice system prompt.
function summarizePrefs(prefs) {
  if (!prefs || !Object.keys(prefs).length) return '';
  const lines = Object.entries(prefs).map(([k, v]) => `${k}: ${v}`);
  return lines.join(' · ').slice(0, 600);
}

module.exports = { chat, getPrefs, savePrefs, removePref, history, summarizePrefs, isConfigured };
