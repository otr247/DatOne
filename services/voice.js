// services/voice.js — AI voice agent (v3: Twilio + Gemini Live, no Vapi).
//
// Architecture (chosen for cost + professionalism — see VOICE_AI_ROADMAP.md):
//   Twilio phone number → outbound call to broker (conference room)
//   Twilio Conference + Media Stream (attached to the broker participant)
//   → our WebSocket /api/voice/ws → Gemini Live API (BidiGenerateContent,
//   Google AI Studio key) speaks as an EXPERT FREIGHT DISPATCHER.
//
// Cost ≈ $0.02–0.07/min (Twilio ~$0.014/min + streams $0.004/min + recording
// $0.0025/min + Gemini Live ~$0.02–0.05/min, free tier available) vs Vapi's
// $0.08–0.12/min.
//
// Features (all owner-scoped):
//   • Live transcript while the call is running — agent side from Gemini text
//     parts, broker side from Deepgram streaming STT (optional DEEPGRAM_API_KEY;
//     without it the transcript shows the agent side only).
//   • Negotiation brain — same guardrails as the email bots: the agent always
//     pushes toward the market rate for the lane (queried from the DAT board
//     at call placement), never books below the floor.
//   • Alert + human takeover — when the broker is close to booking, accepts,
//     or the agent is stuck, needs_human is set; the UI alerts, and "Take
//     Over" dials the dispatcher (VOICE_FORWARD_TO) into the same conference.
//   • Recordings (Twilio, ▶ in Call Log) + live listening (audio relay WS).
//   • Voice rotation per call (GEMINI_VOICE comma list).
//
// Requires env (see .env.example / render.yaml):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER,
//   GEMINI_API_KEY, APP_BASE_URL; optional GEMINI_MODEL, GEMINI_VOICE,
//   DEEPGRAM_API_KEY, MC_NUMBER, COMPANY_NAME, VOICE_FORWARD_TO.

const crypto = require('crypto');
const { WebSocket } = require('ws'); // client used for Gemini Live + Deepgram
const { getDb } = require('../db');
const dat = require('./dat');
const negotiator = require('./negotiator'); // reuse decideNextAction/extractOffer
const aiChat = require('./ai-chat'); // fleet preferences taught in the AI chat

// ─── Config ──────────────────────────────────────────────────────────────────

function isConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    && process.env.TWILIO_FROM_NUMBER && process.env.GEMINI_API_KEY);
}

function appBase() {
  return (process.env.APP_BASE_URL || 'https://dat-one.onrender.com').replace(/\/+$/, '');
}
function wsBase() {
  return appBase().replace(/^http/, 'ws');
}
function geminiModel() {
  return process.env.GEMINI_MODEL || 'gemini-2.5-flash-live';
}
function geminiVoices() {
  // Curated to the most natural, professional-sounding Gemini Live voices.
  // Set GEMINI_VOICE in env to override (comma list, rotated per call).
  const list = (process.env.GEMINI_VOICE || 'Puck,Charon,Kore,Fenrir,Leda,Zephyr')
    .split(',').map(v => v.trim()).filter(Boolean);
  return list.length ? list : ['Puck'];
}
let voiceIdx = 0;
function nextVoice() {
  const list = geminiVoices();
  const v = list[voiceIdx % list.length];
  voiceIdx++;
  return v;
}

// ─── Twilio REST helper (raw fetch — no SDK needed) ─────────────────────────

const TWILIO_API = 'https://api.twilio.com/2010-04-01';
function twilioAuth() {
  return 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
}
async function twilioPost(path, params) {
  const body = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  const res = await fetch(`${TWILIO_API}/Accounts/${process.env.TWILIO_ACCOUNT_SID}${path}.json`, {
    method: 'POST',
    headers: { Authorization: twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Twilio API error ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// Send DTMF digits after answer for broker extensions ("x123" style posts are
// skipped — only real numeric extensions are dialed).
function sendDigitsFor(extension) {
  const ext = String(extension || '').trim();
  if (!ext) return null;
  if (!/^[0-9]+$/.test(ext)) return null;
  return `,,${ext}`; // ~2s pause, then dial the extension
}

// ─── Market research (the "mock dot": query the DAT board for the lane) ──────

async function marketRatesForLane({ origin, destination, equipment }) {
  try {
    const loads = await dat.search({ origin, destination, equipment: equipment || '', sort: 'rate_desc', max_age: 720 });
    const rates = loads.map(l => Number(l.rate) || 0).filter(r => r > 0);
    if (!rates.length) return { market_rate: 0, top_posts: 0 };
    return { market_rate: Math.max(...rates), top_posts: rates.length };
  } catch (e) {
    console.error('[Voice] market research failed:', e.message);
    return { market_rate: 0, top_posts: 0 };
  }
}

// ─── Transcript + negotiation helpers ────────────────────────────────────────

async function appendTranscript(callId, line) {
  if (!line) return;
  try {
    const row = await getDb().get('SELECT transcript_summary FROM voice_calls WHERE id = ?', callId);
    const cur = (row && row.transcript_summary) || '';
    const next = (cur ? cur + '\n' : '') + line;
    await getDb().run('UPDATE voice_calls SET transcript_summary = ? WHERE id = ?', [next.slice(-20000), callId]);
  } catch (e) { console.error('[Voice] transcript write:', e.message); }
}

// Alert when the broker is close to booking / accepts / the agent is stuck.
async function detectNegotiation(call, brokerLine) {
  try {
    const decision = negotiator.decideNextAction({
      replyText: brokerLine,
      minRate: call.min_rate || 0,
      targetRate: call.target_rate || 0,
      round: (call._round || 0) + 1,
      maxRounds: 4
    });
    call._round = (call._round || 0) + 1;

    // Step ladder: log every offer the broker makes
    if (decision.offer) {
      await appendTranscript(call.id,
        `[Step ${call._round}] Broker offered $${decision.offer} · floor $${Math.round(call.min_rate || 0)} · target $${Math.round(call.target_rate || 0)} — ${decision.reason}`);
    }

    let reason = null;
    if (decision.action === 'accept') reason = `Close to booking — ${decision.reason}`;
    else if (decision.action === 'end' && decision.reason === 'max_rounds') reason = 'Stuck — max negotiation rounds reached';
    else if (decision.offer && Number(decision.offer) >= Number(call.min_rate || 0)) reason = `Broker offered $${decision.offer} (≥ floor)`;
    if (!reason) return;

    await getDb().run(
      'UPDATE voice_calls SET needs_human = 1, alert_reason = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [reason, call.id]
    );
    await logEvent('twilio-gemini', { type: 'needs_human', callId: call.id, reason });
  } catch (e) {
    console.error('[Voice] negotiation detect:', e.message);
  }
}

// ─── Outbound call creation ──────────────────────────────────────────────────

// Load = normalized DAT load object (from the board row). Creates the Twilio
// call with the broker in a conference room; the media stream gets attached
// when the participant joins (see attachStreamToParticipant in server.js flow).
async function createOutboundCall({ ownerId, load, context }) {
  if (!isConfigured()) {
    throw new Error('Voice AI is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER and GEMINI_API_KEY (see .env.example)');
  }
  const phone = String((load && load.contact) || '').trim();
  if (!phone) throw new Error('No phone number for this contact');

  const lane = [load.origin, load.destination].filter(Boolean).join(' → ');
  const { market_rate } = await marketRatesForLane({
    origin: load.origin, destination: load.destination, equipment: load.equipment
  });
  const posted = Number(load.rate) || 0;
  const market = market_rate || posted;
  const target = Math.max(market, posted);
  const min = Math.round((posted && market ? Math.min(posted, market) : posted || market) * 0.9);

  const voice = nextVoice();
  // Fleet prefs taught in the AI chat (MC per area, preferred rates, limits…)
  const prefsSummary = aiChat.summarizePrefs(await aiChat.getPrefs(ownerId).catch(() => ({})));
  const info = await getDb().run(
    `INSERT INTO voice_calls
       (owner_id, dat_load_id, broker_name, phone, provider, status, target_rate, min_rate, market_rate, voice, context)
     VALUES (?,?,?,?,?,?, 'requested', ?,?,?,?)`,
    [ownerId, load.id ? String(load.id) : null, (load.broker || '').trim() || 'Broker',
     phone, 'twilio-gemini', target, min, market, voice,
     JSON.stringify({ ref: load.ref || '', lane, equipment: load.equipment || '', rate: posted, context: context || '', prefs: prefsSummary }).slice(0, 2000)]
  );
  const callId = info.lastID;

  try {
    const base = appBase();
    const call = await twilioPost('/Calls', {
      To: phone,
      From: process.env.TWILIO_FROM_NUMBER,
      SendDigits: sendDigitsFor(load.extension),
      Url: `${base}/api/voice/twilio/voice?callId=${callId}`,
      StatusCallback: `${base}/api/voice/twilio/status?callId=${callId}`,
      StatusCallbackEvent: 'initiated ringing answered completed',
      Record: 'true',
      RecordingStatusCallback: `${base}/api/voice/twilio/status?callId=${callId}&recording=1`,
      RecordingStatusCallbackEvent: 'completed',
      Timeout: '30'
    });
    await getDb().run(
      'UPDATE voice_calls SET twilio_call_sid = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [call.sid, callId]
    );
    return { callId, twilioCallSid: call.sid, market_rate: market, target_rate: target, voice };
  } catch (e) {
    await getDb().run("UPDATE voice_calls SET status = 'failed', alert_reason = ? WHERE id = ?",
      [String(e.message).slice(0, 300), callId]);
    throw e;
  }
}

// TwiML for the outbound leg: put the broker in conference room_{callId}.
function twimlForCall(callId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeLimit="900">
    <Conference
      beep="false"
      startConferenceOnEnter="true"
      endConferenceOnExit="true"
      waitUrl=""
      statusCallback="${appBase()}/api/voice/twilio/status?callId=${callId}"
      statusCallbackEvent="start join leave end"
      statusCallbackMethod="POST">room_${callId}</Conference>
  </Dial>
</Response>`;
}

// Attach a Media Stream to the broker's conference participant so Gemini can
// hear/speak on the call. NOTE: Twilio's Streams-in-conference resource is
// POST /Conferences/{confSid}/Participants/{partSid}/Streams — confirm the
// exact path on your account's API docs; if it differs, adjust ONLY this
// function (everything else stays).
async function attachStreamToParticipant(conferenceSid, participantSid, callId) {
  return await twilioPost(`/Conferences/${conferenceSid}/Participants/${participantSid}/Streams`, {
    Url: `${wsBase()}/api/voice/ws?callId=${callId}`,
    Track: 'both',
    StatusCallback: `${appBase()}/api/voice/twilio/status?callId=${callId}`
  });
}

// ─── Media Streams ↔ Gemini Live bridge ──────────────────────────────────────

// G.711 mu-law <-> PCM16 codecs (8kHz telephony audio)
function mulawToPcm16(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    let u = (~buf[i]) & 0xFF; // mask to 8 bits — ~ in JS is 32-bit signed
    let t = ((u & 0x0f) << 3) | 0x84;
    t <<= (u & 0x70) >> 4;
    let v = (u & 0x80) ? (0x84 - t) : (t - 0x84);
    out.writeInt16LE(v, i * 2);
  }
  return out;
}
function pcm16ToMulaw(buf) {
  // mu-law encoder matched to mulawToPcm16()'s 16-bit convention:
  //   biased = pcm + 132, exp = max e with 132*2^e <= biased,
  //   mant = floor((biased - 132*2^e) / (8*2^e)), byte = ~(sign|exp<<4|mant)
  const out = Buffer.alloc(buf.length / 2);
  for (let i = 0; i < out.length; i++) {
    let pcm = buf.readInt16LE(i * 2);
    const sign = (pcm >> 8) & 0x80;
    if (sign) pcm = -pcm;
    if (pcm > 32635) pcm = 32635;
    const biased = pcm + 0x84;
    let exp = 7;
    while (exp > 0 && biased < (0x84 << exp)) exp--;
    let mant = Math.floor((biased - (0x84 << exp)) / (8 << exp));
    if (mant > 15) mant = 15;
    out[i] = ~(sign | (exp << 4) | mant);
  }
  return out;
}

// ─── Ambient room-tone (makes the call feel like a real office, not a lab) ──
// Very low brown-noise bed mixed under the agent's voice; when the agent is
// silent, a soft room-tone chunk keeps the line sounding alive (air hum,
// faint traffic — the texture of a real phone call). Level: VOICE_AMBIENT_LEVEL
// (0..0.15, default 0.035 = subtle; set 0 to disable).
const AMBIENT_CHUNK_SAMPLES = 320; // 40ms @ 8kHz
function ambientLevel() {
  const v = parseFloat(process.env.VOICE_AMBIENT_LEVEL || '');
  return isNaN(v) ? 0.035 : Math.max(0, Math.min(0.15, v));
}
let noiseChunks = null;
function ambientChunk() {
  if (!noiseChunks) {
    noiseChunks = [];
    let y = 0;
    for (let c = 0; c < 40; c++) { // ~1.6s of room tone, looped/randomized
      const pcm = Buffer.alloc(AMBIENT_CHUNK_SAMPLES * 2);
      for (let i = 0; i < AMBIENT_CHUNK_SAMPLES; i++) {
        y += (Math.random() * 2 - 1) * 2200; // brown noise ≈ air/AC rumble
        if (y > 30000) y = 30000; else if (y < -30000) y = -30000;
        pcm.writeInt16LE(Math.round(y), i * 2);
      }
      noiseChunks.push(pcm);
    }
  }
  return noiseChunks[Math.floor(Math.random() * noiseChunks.length)];
}
function mixAmbient(agentPcm) {
  const level = ambientLevel();
  if (level <= 0 || !agentPcm || !agentPcm.length) return agentPcm;
  const noise = ambientChunk();
  const out = Buffer.alloc(agentPcm.length);
  for (let i = 0; i < agentPcm.length; i += 2) {
    const a = agentPcm.readInt16LE(i);
    const n = noise.readInt16LE(i % noise.length);
    let v = a + Math.round(n * level);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    out.writeInt16LE(v, i);
  }
  return out;
}

// ─── Typing sound ("let me check with the driver" → soft keyboard clicks) ──
// Short low-gain click bursts, ~1-2s, while the agent "checks" — sells the
// human side of "let me check with the driver/owner".
function typingClick() {
  const samples = 24; // ~3ms @ 8kHz, fast-decay noise tap
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const env = Math.exp(-i / 4);
    pcm.writeInt16LE(Math.round((Math.random() * 2 - 1) * 9000 * env), i * 2);
  }
  return pcm;
}
function startTyping(state) {
  if (state.typingTimer) return;
  const max = 10 + Math.floor(Math.random() * 6);
  let clicks = 0;
  const fire = () => {
    if (clicks >= max || !state.ws || !state.twilioStreamSid) { stopTyping(state); return; }
    safeSend(state.ws, JSON.stringify({ event: 'media', streamSid: state.twilioStreamSid, media: { payload: pcm16ToMulaw(typingClick()).toString('base64') } }));
    state.lastAgentAudio = Date.now(); // keep room-tone timer quiet during typing
    clicks++;
    state.typingTimer = setTimeout(fire, 70 + Math.random() * 140);
  };
  fire();
}
function stopTyping(state) {
  if (state.typingTimer) { clearTimeout(state.typingTimer); state.typingTimer = null; }
}

// Active call sockets: callId → { ws (twilio stream), gemini, deepgram, live:Set }
const activeCalls = new Map();

function liveListeners(callId) { return activeCalls.get(callId)?.live || new Set(); }

async function handleStream(ws, query) {
  const callId = Number(query.callId);
  if (!callId) { ws.close(4000, 'no callId'); return; }
  const call = await getDb().get('SELECT * FROM voice_calls WHERE id = ?', callId);
  if (!call) { ws.close(4004, 'call not found'); return; }

  const state = { twilioStreamSid: null, gemini: null, deepgram: null, agentBuf: '', ws, call };
  activeCalls.set(callId, { ...state, live: new Set() });

  const openGemini = () => {
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
    const g = new WebSocket(url);
    state.gemini = g;
    g.onopen = () => {
      const systemText = buildSystemPrompt(call);
      g.send(JSON.stringify({
        setup: {
          model: geminiModel(),
          generationConfig: {
            responseModalities: ['TEXT', 'AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: call.voice || 'Puck' } } },
            outputAudioFormat: { mimeType: 'audio/L16;rate=8000' },
            temperature: 0.7
          },
          systemInstruction: { parts: [{ text: systemText }] }
        }
      }));
    };
    g.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.setupComplete) { logEvent('twilio-gemini', { type: 'gemini.ready', callId }); return; }
        const sc = msg.serverContent;
        if (!sc) return;
        if (sc.interrupted) {
          // agent was cut off — clear any buffered audio on the Twilio stream
          safeSend(ws, JSON.stringify({ event: 'clear' }));
          return;
        }
        for (const part of (sc.modelTurn && sc.modelTurn.parts) || []) {
          if (part.inlineData && part.inlineData.data) {
            const l16 = Buffer.from(part.inlineData.data, 'base64');
            const mulaw = pcm16ToMulaw(mixAmbient(l16)).toString('base64'); // + room tone
            safeSend(ws, JSON.stringify({ event: 'media', streamSid: state.twilioStreamSid, media: { payload: mulaw } }));
            state.lastAgentAudio = Date.now();
          } else if (part.text) {
            state.agentBuf += part.text;
          }
        }
        if (sc.turnComplete && state.agentBuf.trim()) {
          const text = state.agentBuf.trim().replace(/\s+/g, ' ');
          const line = `agent: ${text}`;
          state.agentBuf = '';
          await appendTranscript(callId, line);
          // Step ladder: log every price the agent states out loud
          const amt = text.match(/\$\s?([\d,]+)/);
          if (amt) await appendTranscript(callId, `[Step] Agent asked $${amt[1].replace(/,/g, '')}`);
          // Typing sound when the agent says it's checking with driver/owner
          if (/check|driver|owner|one sec|one second|looking|let me see/i.test(text)) {
            setTimeout(() => startTyping(state), 350);
          }
          for (const l of liveListeners(callId)) safeSend(l, JSON.stringify({ type: 'transcript', line }));
        }
      } catch (e) { console.error('[Voice] gemini msg:', e.message); }
    };
    g.onerror = () => logEvent('twilio-gemini', { type: 'gemini.error', callId });
    g.onclose = () => { state.gemini = null; };
  };

  const openDeepgram = () => {
    if (!process.env.DEEPGRAM_API_KEY) return;
    const dg = new WebSocket(`wss://api.deepgram.com/v1/listen?model=nova-2&encoding=mulaw&sample_rate=8000&channels=1&interim_results=false&endpointing=300&punctuate=true`);
    state.deepgram = dg;
    dg.onopen = () => dg.send(JSON.stringify({ type: 'ConfigureAuth', token: process.env.DEEPGRAM_API_KEY }));
    dg.onmessage = async (ev) => {
      try {
        const j = JSON.parse(ev.data);
        if (j.type === 'Results' && j.channel && j.channel.alternatives && j.channel.alternatives[0]) {
          const txt = j.channel.alternatives[0].transcript.trim();
          if (txt && j.is_final !== false) {
            const line = `broker: ${txt}`;
            await appendTranscript(callId, line);
            for (const l of liveListeners(callId)) safeSend(l, JSON.stringify({ type: 'transcript', line }));
            await detectNegotiation(call, txt);
            await maybeEtaCheck(call, txt);
          }
        }
      } catch (e) { /* non-fatal */ }
    };
    dg.onclose = () => { state.deepgram = null; };
  };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    switch (msg.event) {
      case 'connected': break;
      case 'start': {
        state.twilioStreamSid = msg.streamSid;
        await getDb().run("UPDATE voice_calls SET stream_sid = ?, status = 'in-progress' WHERE id = ?", [msg.streamSid, callId]);
        if (state.gemini) state.gemini.close();
        openGemini();
        openDeepgram();
        // Soft room-tone in the gaps between the agent's sentences — keeps the
        // line sounding like a real phone call, never dead air.
        state.lastAgentAudio = 0;
        state.noiseTimer = setInterval(() => {
          if (state.handoff) return; // human took over — drop the bed
          if (state.lastAgentAudio && Date.now() - state.lastAgentAudio < 300) return; // agent speaking
          if (!state.twilioStreamSid || !state.ws) return;
          const mul = pcm16ToMulaw(ambientChunk()).toString('base64');
          safeSend(state.ws, JSON.stringify({ event: 'media', streamSid: state.twilioStreamSid, media: { payload: mul } }));
        }, 40);
        break;
      }
      case 'media': {
        const payload = msg.media || {};
        if (!state.gemini || !payload.payload) return;
        // outbound = the participant's own mic (the broker)
        if (payload.track === 'outbound' || payload.track === undefined) {
          if (state.deepgram && state.deepgram.readyState === WebSocket.OPEN) {
            state.deepgram.send(JSON.stringify({ type: 'SendAudio', audio: { data: payload.payload } }));
          }
          const l16 = mulawToPcm16(Buffer.from(payload.payload, 'base64')).toString('base64');
          state.gemini.send(JSON.stringify({ realtimeInput: { audio: { data: l16 } } }));
        }
        for (const l of liveListeners(callId)) safeSend(l, JSON.stringify({ type: 'audio', payload: payload.payload }));
        break;
      }
      case 'stop':
      case 'dtmf':
        break;
    }
  });

  ws.on('close', () => {
    if (state.noiseTimer) clearInterval(state.noiseTimer);
    stopTyping(state);
    try { state.gemini && state.gemini.close(); } catch (_) {}
    try { state.deepgram && state.deepgram.close(); } catch (_) {}
    const a = activeCalls.get(callId);
    if (a) { for (const l of a.live) { try { l.close(); } catch (_) {} } }
    activeCalls.delete(callId);
    logEvent('twilio-gemini', { type: 'stream.closed', callId });
  });

  // Wait for Gemini to be ready before accepting media
  ws.on('error', () => { try { ws.close(); } catch (_) {} });
}

function safeSend(ws, data) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(data); } catch (_) {}
}

// ─── Live listen relay ───────────────────────────────────────────────────────

function handleLiveSocket(ws, query) {
  const callId = Number(query.callId);
  if (!callId) { ws.close(4000, 'no callId'); return; }
  const entry = activeCalls.get(callId);
  if (!entry) { ws.close(4004, 'call not active'); return; }
  entry.live.add(ws);
  const call = entry.call;
  safeSend(ws, JSON.stringify({ type: 'hello', callId, status: call.status, transcript: call.transcript_summary || '' }));
  ws.on('close', () => { entry.live.delete(ws); });
  ws.on('error', () => { entry.live.delete(ws); });
}

// ─── Take-over & end ─────────────────────────────────────────────────────────

// Dial the dispatcher (VOICE_FORWARD_TO) into the call's conference room.
async function joinCall(callId, ownerId) {
  const call = await getDb().get('SELECT * FROM voice_calls WHERE id = ? AND owner_id = ?', [callId, ownerId]);
  if (!call) throw new Error('Call not found');
  if (!call.twilio_call_sid) throw new Error('Call not connected yet');
  if (!process.env.VOICE_FORWARD_TO) throw new Error('VOICE_FORWARD_TO not set — dispatcher number for take-over is required');

  const ctx = JSON.parse(call.context || '{}');
  const conferenceSid = call.conference_sid;
  if (!conferenceSid) throw new Error('Conference not established yet — try again in a few seconds');

  // Put the dispatcher into the same conference room
  await twilioPost(`/Conferences/${conferenceSid}/Participants`, {
    From: process.env.TWILIO_FROM_NUMBER,
    To: process.env.VOICE_FORWARD_TO,
    StatusCallback: `${appBase()}/api/voice/twilio/status?callId=${callId}&join=1`,
    StatusCallbackEvent: 'join leave',
    Coaching: 'false',
    EarlyMedia: 'true'
  });
  await appendTranscript(callId, '[system] Dispatcher takeover dialing — the agent will hand off');
  // Tell the agent to stop talking: close Gemini and clear buffered audio
  const entry = activeCalls.get(callId);
  if (entry && entry.ws) {
    safeSend(entry.ws, JSON.stringify({ event: 'clear' }));
  }
  await logEvent('twilio-gemini', { type: 'takeover.requested', callId, ownerId, lane: ctx.lane || '' });
  return { ok: true };
}

async function endCall(callId, ownerId) {
  const call = await getDb().get('SELECT * FROM voice_calls WHERE id = ? AND owner_id = ?', [callId, ownerId]);
  if (!call) throw new Error('Call not found');
  if (!call.twilio_call_sid) return { ok: true, already: true };
  await twilioPost(`/Calls/${call.twilio_call_sid}`, { Status: 'completed' });
  return { ok: true };
}

// ─── Twilio status/recording/conference callbacks ────────────────────────────

async function updateFromTwilio(payload, callId, opts = {}) {
  const call = await getDb().get('SELECT * FROM voice_calls WHERE id = ?', callId).catch(() => null);
  const statusMap = {
    'in-progress': 'in-progress', ringing: 'in-progress', queued: 'requested',
    initiated: 'requested', completed: 'ended', busy: 'failed',
    'no-answer': 'failed', canceled: 'failed', failed: 'failed', 'call-ended': 'ended'
  };
  if (opts.recording && payload.RecordingUrl) {
    await getDb().run('UPDATE voice_calls SET recording_url = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [String(payload.RecordingUrl).slice(0, 500), callId]);
    return { ok: true, kind: 'recording' };
  }
  if (payload.ConferenceSid) {
    // Conference events (start/join/leave/end)
    if (payload.FriendlyName === `room_${callId}` || opts.join) {
      await getDb().run('UPDATE voice_calls SET conference_sid = ?, status = \'in-progress\' WHERE id = ?',
        [String(payload.ConferenceSid).slice(0, 64), callId]);
    }
    // When the BROKER joins the room, attach the media stream so Gemini can
    // hear/speak. When the DISPATCHER joins (opts.join), note the takeover.
    const evt = String(payload.StatusCallbackEvent || '');
    if (evt === 'join' && !opts.join && payload.CallSid === call.twilio_call_sid && payload.ParticipantSid) {
      attachStreamToParticipant(payload.ConferenceSid, payload.ParticipantSid, callId)
        .then(() => logEvent('twilio-gemini', { type: 'stream.attached', callId }))
        .catch(e => console.error('[Voice] attach stream:', e.message));
    }
    if (opts.join && (evt === 'join' || evt === 'leave')) {
      await appendTranscript(callId, evt === 'join'
        ? '[system] Dispatcher joined — human takeover active'
        : '[system] Dispatcher left the call');
    }
    if (evt === 'end' || evt === 'conference-end') {
      await getDb().run("UPDATE voice_calls SET status = 'ended' WHERE id = ?", [callId]);
    }
    return { ok: true, kind: 'conference' };
  }
  const status = statusMap[payload.CallStatus || ''];
  if (status) {
    await getDb().run("UPDATE voice_calls SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, callId]);
    if (status === 'ended') await appendTranscript(callId, '[system] Call ended');
  }
  return { ok: true, kind: 'status' };
}

// ─── Expert dispatcher system prompt ─────────────────────────────────────────

// Randomize the delivery style per call so no two calls feel scripted.
const CALL_STYLES = [
  'Crisp and businesslike; get to the point fast, but never rushed.',
  'Warm and unhurried; sound like you have a minute to talk, not in a hurry to hang up.',
  'Confident and relaxed; a senior dispatcher who has done this a thousand times.',
  'Friendly and direct; short sentences, a little dry humor only if it fits naturally.'
];

// ETA check: if the broker states a pickup time within ~30 min of our ETA,
// reassure + log a highlighted note; bigger gaps get flagged for the fleet manager.
const pad2 = n => String(n).padStart(2, '0');
async function maybeEtaCheck(call, text) {
  const etaMin = parseInt(process.env.VOICE_ETA_MIN || '0', 10);
  if (!(etaMin > 0)) return;
  const m = String(text || '').toLowerCase().match(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/);
  if (!m) return;
  let h = Number(m[1]);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  const eta = new Date(Date.now() + etaMin * 60000);
  const diffMin = Math.abs((eta.getHours() * 60 + eta.getMinutes()) - (h * 60 + Number(m[2] || 0)));
  if (diffMin <= 30) {
    await appendTranscript(call.id,
      `[⚠ ETA check] Broker expects pickup ~${pad2(h)}:${pad2(Number(m[2] || 0))} · our ETA ~${pad2(eta.getHours())}:${pad2(eta.getMinutes())} — reassured "we'll be there before that"`);
  } else if (diffMin > 45) {
    await appendTranscript(call.id,
      `[⚠ ETA gap] Broker pickup ~${pad2(h)}:${pad2(Number(m[2] || 0))} vs our ETA ~${pad2(eta.getHours())}:${pad2(eta.getMinutes())} — flag for fleet manager`);
  }
}

function buildSystemPrompt(call) {
  const ctx = (() => { try { return JSON.parse(call.context || '{}'); } catch (_) { return {}; } })();
  const company = process.env.COMPANY_NAME || 'our dispatch company';
  const mc = process.env.MC_NUMBER ? ` MC #${process.env.MC_NUMBER}` : '';
  const lane = ctx.lane || 'the lane';
  const equip = ctx.equipment || '';
  const ref = ctx.ref ? ` Reference: ${ctx.ref}.` : '';
  const market = call.market_rate ? ` Market research shows top posted rate on this lane is about $${Math.round(call.market_rate).toLocaleString()}.` : '';
  const target = call.target_rate ? ` Aim for $${Math.round(call.target_rate).toLocaleString()} — that is the highest rate we can reasonably ask.` : '';
  const min = call.min_rate ? ` Never accept below $${Math.round(call.min_rate).toLocaleString()}.` : '';
  const prefs = ctx.prefs
    ? `FLEET PREFERENCES (set by the dispatcher — treat as ground truth, use the matching truck/MC/area details when they apply): ${ctx.prefs}`
    : '';
  const identityRule = String(process.env.VOICE_AI_DISCLOSE || '0') === '1'
    ? `IF ASKED "ARE YOU AN AI/ROBOT/AUTOMATED?": be transparent — say you're an AI assistant calling for ${company}, then immediately steer back to the call's purpose.`
    : `IF ASKED "ARE YOU AN AI/ROBOT/AUTOMATED?": answer naturally and briefly, like any person would — e.g. "No, I'm not — I'm calling about the load, ha. Anyway…" — then immediately steer back to the call. Never dwell on it, never volunteer the topic.`;

  const truckCity = (process.env.VOICE_TRUCK_CITY || '').trim();
  const etaMin = parseInt(process.env.VOICE_ETA_MIN || '0', 10);
  const position = [
    `TIMING & POSITION: the truck is EMPTY right now${truckCity ? `, currently near ${truckCity}` : ''}${etaMin > 0 ? `, about ${etaMin} minutes from the pickup` : ''}.`,
    `If the broker gives a pickup time within ~30 minutes of your ETA (or earlier), never worry them: say confidently "we'll be there before that" and move on — handle minor discrepancies swiftly, never argue small timing differences.`,
    `When discussing positioning, place the truck close to the pickup — keep the broker confident about coverage; do not volunteer long empty miles.`,
    `If a timing conflict looks bigger than ~30 minutes, mention you'll confirm it with the fleet manager and move on.`
  ].filter(Boolean).join('\n');

  return [
    `You are an expert US freight dispatcher calling on behalf of ${company}${mc}. You sound professional, confident and brief — real dispatchers don't waste a broker's time.`,
    `CURRENT LOAD: ${lane}${equip ? ` (${equip})` : ''}${ref}`,
    market, target, min, prefs,
    `OPENING: When the broker answers, go STRAIGHT to the load — do not introduce yourself as an assistant and never say "AI" or "agent". Lead with something like: "Hey, you posted this load going from ${lane}${equip ? `, ${equip}` : ''} — I need a few more details on it." (adapt naturally).`,
    `DETAILS: Write down everything the broker tells you — origin, destination, pickup/delivery times, equipment, weight, rate, reference number, special instructions. If you hardly caught something, politely ask them to repeat it ("Sorry, I missed the pickup time — could you say that again?"). Never pretend you got it when you didn't.`,
    position,
    `RATE SCRIPT (the feel, not word-for-word):
      1) First ask: "Okay, what's your best rate on this one?" — use their name, or "boss"/"sir" naturally.
      2) Whatever they say, if it's below target: "Umm, okay — let me check with the driver real quick." (short pause)
      3) Then: "Okay, they asked for $<counter> — can you make it that?" where <counter> is your next ask toward the target.
      4) If they push back: "Umm, okayy, I'm checking." (short pause) then push a little more.
      5) Keep stepping up in small increments toward the target. NEVER go below the floor (${min ? '$' + Math.round(call.min_rate).toLocaleString() : 'your minimum'}).
      6) State prices clearly out loud at every step so the call log shows the full ladder.`,
    `HANDOFF RULE: When the broker agrees at or above the floor, says "book it", or won't move anymore, say: "Okay, let me connect you with my fleet manager for this one." Then stay quiet — a human dispatcher is joining the call. Do NOT continue negotiating after that.`,
    `SPEAK LIKE A REAL HUMAN ON THE PHONE: vary your pace, use short sentences, and pause naturally. Occasionally use light conversational fillers a real dispatcher would ("let me check", "one second", "okay", "right", "got it"). Never sound scripted, robotic, or like you are reading a list. Keep it warm and confident.`,
    `STYLE FOR THIS CALL: ${CALL_STYLES[Math.floor(Math.random() * CALL_STYLES.length)]}`,
    `EQUIPMENT KNOWLEDGE: You know all truck types and specs — Van (53' dry), Reefer (temp-controlled), Flatbed, Step Deck, RGN, Conestoga, Lowboy, Power Only, Auto, Hotshot, Tanker, Bulk, Double Drop, Stretch, Container, Dump, End Dump, Side Dump, Hopper Bottom, Pneumatic, Livestock, Logging, Car Carrier. You reason about weight (typical 40k-48k lbs), length (48'/53'), and rate-per-mile so you never accept a rate that loses money.`,
    identityRule,
    `NEVER invent MC numbers, company names, or rates. Never promise anything beyond the load details above. If the load is gone, thank them and end politely.`,
    `End every completed conversation with a brief, natural goodbye.`
  ].filter(Boolean).join('\n');
}

// ─── Misc ────────────────────────────────────────────────────────────────────

async function logEvent(provider, event) {
  try {
    await getDb().run(
      'INSERT INTO voice_events (provider, event_type, payload) VALUES (?,?,?)',
      [provider || 'twilio-gemini', event.type || 'unknown', JSON.stringify(event).slice(0, 8000)]
    );
  } catch (e) { console.error('[Voice] logEvent:', e.message); }
}

async function listCalls(ownerId) {
  return await getDb().all(
    'SELECT * FROM voice_calls WHERE owner_id = ? ORDER BY id DESC LIMIT 200',
    [ownerId]
  );
}

module.exports = {
  isConfigured, logEvent, listCalls,
  createOutboundCall, twimlForCall, attachStreamToParticipant,
  handleStream, handleLiveSocket, joinCall, endCall, updateFromTwilio,
  marketRatesForLane, mulawToPcm16, pcm16ToMulaw
};
