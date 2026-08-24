// services/ai.js — AI draft generator with template fallback
// If OPENAI_API_KEY is present we call an OpenAI-compatible endpoint.
// Otherwise we return varied, professional templates so the feature always works.
//
// v2.5: every Generate click produces a NEW draft — the AI gets explicit
// variety instructions plus a randomized style seed, and the fallback picks
// randomly from multiple variants per template kind.

function isConfigured() { return !!process.env.OPENAI_API_KEY; }

// ─── Fallback templates (multiple variants per kind, chosen at random) ──────

const VARIANTS = {
  inquiry: [
    (B, lane, R, money) => `Hi ${B},\n\nIs the ${lane} load${R} still available? We have a truck that fits and can commit quickly if the numbers work. What's your target rate?\n\nThanks,\n[Your Name]\n[Company] • MC #`,
    (B, lane, R) => `Hello ${B},\n\nQuick one — do you still have coverage on ${lane}${R}? We've got capacity ready to go and can move fast on it. What's the best rate you can do?\n\nBest regards,\n[Your Name] • [Company]`,
    (B, lane, R, money) => `Hi ${B},\n\nChecking availability on ${lane}${R}. We're a dependable carrier with a driver in position — if it's open, send over your best number and we'll confirm same day.\n\nThanks,\n[Your Name]`,
    (B, lane, R) => `Good morning ${B},\n\nDo you have a truck needed on ${lane}${R}? We can cover it — let me know the current rate and I'll get it locked in.\n\nThanks,\n[Your Name] • [Company] • MC #`
  ],
  negotiate: [
    (B, lane, R, money) => `Hi ${B},\n\nThanks for sending over the ${lane} load${R}. We're interested but the numbers need a small adjustment on our side — could you do ${money} all-in? We can cover it today with a solid driver and quick check calls.\n\nAppreciate it,\n[Your Name]\n[Company] • MC #`,
    (B, lane, R, money) => `Hello ${B},\n\nWe'd love to take ${lane}${R}, and the lane works well for us — but we'd need closer to ${money} to make it work. Can you meet us there? If so, it's confirmed today.\n\nThanks,\n[Your Name]`,
    (B, lane, R, money) => `Hi ${B},\n\nOn ${lane}${R} — our costs on this one run a bit high, so we're looking for ${money} all-in. If you can hit that we're locked in, otherwise let's see if we can split the difference.\n\nBest,\n[Your Name] • [Company]`
  ],
  book: [
    (B, lane, R, money) => `Hi ${B},\n\nPlease consider us booked on ${lane}${R} at ${money} all-in. Send the rate confirmation to this email and I'll return it signed within the hour. Driver info and truck details to follow shortly.\n\nThanks,\n[Your Name]\n[Company] • MC #`,
    (B, lane, R, money) => `Hello ${B},\n\nConfirmed — we're booked on ${lane}${R} at ${money}. Please send over the rate con and I'll return it signed right away. Driver and truck details coming next.\n\nThanks,\n[Your Name]`,
    (B, lane, R, money) => `Hi ${B},\n\nWe're good to go on ${lane}${R} at ${money} all-in. Send the confirmation and we're locked. Appreciate the business!\n\nBest regards,\n[Your Name] • [Company] • MC #`
  ],
  checkcall: [
    (B, lane, R) => `Hi ${B},\n\nQuick check call on ${lane}${R}: driver is on schedule, no delays, ETA holding as planned. I'll send another update at the next milestone or immediately if anything changes.\n\nThanks,\n[Your Name]`,
    (B, lane, R) => `Hello ${B},\n\nStatus update on ${lane}${R} — all good here, driver en route and on time. Will keep you posted at the next stop.\n\nThanks,\n[Your Name]`,
    (B, lane, R) => `Hi ${B},\n\nJust a heads-up on ${lane}${R} — everything's on track, pickup done, ETA unchanged. Any issues on your end, call me anytime.\n\nThanks,\n[Your Name] • [Company]`
  ]
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function templateDraft({ kind, broker, origin, destination, rate, ref }) {
  const B = broker || 'there';
  const lane = [origin, destination].filter(Boolean).join(' → ') || 'the lane';
  const R = ref ? ` (Ref ${ref})` : '';
  const money = rate ? `$${Number(rate).toLocaleString()}` : 'your best rate';
  const key = String(kind || 'inquiry').toLowerCase();
  const fn = pick(VARIANTS[key] || VARIANTS.inquiry);
  return fn(B, lane, R, money);
}

// ─── AI path with variety ────────────────────────────────────────────────────

// Random style seed — the model re-expresses the message differently per click
const STYLE_SEEDS = [
  'Friendly and conversational; open with a light one-line context.',
  'Direct and businesslike; lead with the ask in the first sentence.',
  'Warm and appreciative; thank them before the ask.',
  'Concise and punchy; three short sentences max.',
  'Professional and formal; structured greeting, ask, close.',
  'Casual dispatcher-to-broker; natural, not stiff.'
];

function randomStyle() {
  return pick(STYLE_SEEDS);
}

// ── OpenAI-compatible chat completion with host-aware model fallback ────────
// Works with Groq (free tier), OpenAI, and Google Gemini's OpenAI-compatible
// endpoint. If the configured model 404s/400s (wrong name for the provider),
// it retries with known-good models for that host before giving up.
function apiBase() {
  let base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (base.includes('generativelanguage.googleapis.com') && !base.includes('/openai')) {
    base += '/v1beta/openai'; // Gemini's OpenAI-compatible path
  }
  return base;
}
function defaultModelFor(base) {
  if (base.includes('groq')) return 'llama-3.1-8b-instant';
  if (base.includes('generativelanguage')) return 'gemini-2.5-flash';
  return 'gpt-4o-mini';
}
function fallbackModelsFor(base) {
  if (base.includes('groq')) return ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'llama3-8b-8192'];
  if (base.includes('generativelanguage')) return ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  return ['gpt-4o-mini', 'gpt-3.5-turbo'];
}
async function chatCompletion(messages, temperature = 0.7) {
  const base = apiBase();
  const candidates = [process.env.OPENAI_MODEL || defaultModelFor(base), ...fallbackModelsFor(base)];
  const seen = new Set();
  let lastErr = null;
  for (const model of candidates) {
    if (seen.has(model)) continue;
    seen.add(model);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature, messages }),
        signal: AbortSignal.timeout(25000)
      });
      if (res.status === 404 || res.status === 400) {
        lastErr = new Error(`AI HTTP ${res.status} on model "${model}" (${base})`);
        continue; // wrong model for this provider — try the next one
      }
      if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
      const j = await res.json();
      const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (typeof content === 'string' && content.trim()) return content.trim();
      lastErr = new Error('AI returned an empty response');
    } catch (e) {
      lastErr = e;
      // 404/400 = model problem → keep trying; anything else (401/network/timeout) → stop
      if (!/404|400/.test(String(e.message))) break;
    }
  }
  throw lastErr || new Error('AI unavailable');
}

async function callOpenAI(payload) {
  const sys = `You are a US freight dispatcher writing short, professional messages to freight brokers. Be concise (max 6 sentences), courteous, and specific. Include a clear ask. Never invent MC numbers or company names — leave placeholders in square brackets.
Style directive for THIS message: ${randomStyle()}
VARIETY: This message must be freshly worded — do not repeat the phrasing, opener, or structure of any earlier message. Vary the greeting, the opening line, the value prop, and the closing. Every generation must read like a new message about the same facts.`;
  const user = `Write a broker message.
Type: ${payload.kind || 'inquiry'}
Broker: ${payload.broker || ''}
Lane: ${payload.origin || ''} to ${payload.destination || ''}
Target rate: ${payload.rate || ''}
Load ref: ${payload.ref || ''}
Notes: ${payload.notes || ''}`;
  return await chatCompletion([
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ], 0.6 + Math.random() * 0.6);
}

async function draft(payload) {
  if (!isConfigured()) return templateDraft(payload);
  try {
    const text = await callOpenAI(payload);
    return text || templateDraft(payload);
  } catch (e) {
    // Silent fallback keeps the UX smooth if the AI call fails
    return templateDraft(payload);
  }
}

module.exports = { isConfigured, draft, chatCompletion, apiBase, defaultModelFor, fallbackModelsFor };
