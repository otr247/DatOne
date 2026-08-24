# DAT One (Dispatch Hub) — MASTER PROJECT CONTEXT v5.0
# Paste this entire file into any new AI chat to continue development with full context.
# Companion docs: README.md, DEPLOYMENT.md, GOOGLE_SETUP.md, VOICE_AI_ROADMAP.md,
# DAT_COMPETITIVE_REVIEW.md, ROOKIE_GUIDE.md (beginner how-to), APP_STORE_GUIDE.md.

---

PROJECT: DAT One — multi-tenant freight dispatcher SaaS ("Dispatch · Paperwork · Profit")
GITHUB REPO: https://github.com/otr247/DatOne (branch main, auto-deploy to Render)
LIVE URL: https://dat-one.onrender.com
STATUS: **Code complete through v4.1 — COMMITTED LOCALLY, PUSH TO GITHUB IS PENDING**
  (user must `git push` / GitHub Desktop Commit+Push — Render still runs the OLD Aug-22 build)
RENDER ENV: user has added TWILIO_*, GEMINI_*, DEEPGRAM_API_KEY, TURSO_* (see Env Vars)

=== TECH STACK ===
- Node.js + Express (no bundler/framework), single-page app (vanilla JS IIFE)
- SQLite via `sqlite`+`sqlite3` (default) OR hosted libSQL/Turso (TURSO_DATABASE_URL) — see Persistence
- cookie-session auth; bcryptjs; multer (file uploads); nodemailer (SMTP emails)
- ws (WebSocket server: Twilio Media Streams + live-listen relay)
- @libsql/client (Turso adapter, v3.3+); @capacitor/* v7 (native app shell, v4.0)
- Hosted on Render free tier

=== FILE STRUCTURE (complete) ===
server.js            — Express API, ALL routes owner-scoped, http server + WS upgrade
db.js                — schema/migrations (ensureColumn pattern) + seed + Turso adapter
services/
  google.js          — per-user Google OAuth + Drive/Sheets/Gmail (gmailSend, gmailSearchMessages, gmailReadMessage, userStatus)
  dat.js             — DAT load board (live API w/ demo fallback, normalizeLoad, search)
  ai.js              — OpenAI-compatible drafts + shared chatCompletion() w/ host-aware model fallback
  ai-chat.js         — AI Fleet Assistant (chat + ai_prefs extraction/summary)
  negotiator.js      — email negotiation bots + decideNextAction state machine (pure, exported)
  outreach.js        — DAT-listing AI emails to brokers + reply polling
  voice.js           — v3 voice agent: Twilio + Gemini Live bridge (createOutboundCall, twimlForCall,
                       attachStreamToParticipant, handleStream, handleLiveSocket, joinCall, endCall,
                       updateFromTwilio, marketRatesForLane, mu-law/PCM16 codecs, ambient noise, typing sounds)
  mail.js            — sendInvite / sendReset / sendUsername via SMTP → connected Gmail → skipped
public/
  index.html         — SPA shell: login + forgot username/password + reset views, sidebar, all pages
  app.js             — all frontend JS (single IIFE; showPage router, state, api() with API_BASE)
  styles.css         — full CSS incl. mobile off-canvas sidebar + chat styles
  manifest.json, sw.js, icons  — PWA (installable)
android/  ios/       — Capacitor native projects (generated, synced; v4.0)
capacitor.config.json, .env.example, .gitignore, package.json, render.yaml
Docs: CONTEXT_PROMPT.md (this), README, DEPLOYMENT, GOOGLE_SETUP, VOICE_AI_ROADMAP,
      DAT_COMPETITIVE_REVIEW, ROOKIE_GUIDE, APP_STORE_GUIDE

=== DATABASE SCHEMA (ALL tables) ===
users               — id, username, password_hash, full_name, email, phone, role, must_change_password,
                      created_at, session_token, reset_token, reset_expires
contacts            — id, owner_id FK, name, company, email, phone, type (broker/carrier/driver),
                      manager_name, dispatch_pct, parent_carrier_id, has_hazmat, has_twic, has_tsa,
                      cdl_type, truck_unit, truck_type, truck_length, truck_weight, driver_notes, notes, created_at
loads               — id, owner_id FK, ref (UNIQUE w/ owner), status, broker, broker_email, broker_phone,
                      origin, destination, pickup_date, delivery_date, equipment, miles, rate, dispatch_fee,
                      carrier_id, driver_id, driver_email, driver_phone, notes, assigned_user, created_at, updated_at
documents           — id, load_id FK CASCADE, filename, mime, size, data BLOB, drive_file_id, created_at
user_integrations   — user_id+provider PK, access_token, refresh_token, expiry_date, scope, token_type,
                      extra (JSON: google email), updated_at
negotiation_campaigns / negotiation_threads / negotiation_messages — email bot state machine
voice_events        — id, provider, event_type, payload JSON, created_at
dat_outreach        — id, owner_id, dat_load_id, broker_name, broker_email, broker_phone, ref_number, lane,
                      direction, subject, body, status (sent|failed|replied), gmail_thread_id, gmail_msg_id,
                      reply_snippet, created_at, updated_at
voice_calls         — id, owner_id, dat_load_id, broker_name, phone, provider, provider_call_id, status
                      (requested|ringing|in-progress|ended|failed), duration_s, transcript_summary,
                      context JSON (ref/lane/equipment/rate/prefs…), twilio_call_sid, stream_sid,
                      conference_sid, recording_url, needs_human, alert_reason, target_rate, min_rate,
                      market_rate, voice, created_at, updated_at
ai_chat             — id, owner_id, role, content, created_at
ai_prefs            — owner_id PK, prefs JSON, updated_at
settings            — key, value
ALL owner-scoped via owner_id/user_id; foreign keys CASCADE on user delete; indexed.

=== MULTI-TENANT DESIGN (CRITICAL) ===
- contacts/loads/documents/negotiation*/outreach/voice_calls/ai_* all scoped owner_id = req.user.id server-side
- Cross-tenant writes blocked (carrier/driver IDs validated owned); admin-only routes via requireAdmin
- Google OAuth is PER-USER (each connects own Google from Settings)
- Admin creates users; must_change_password on first login

=== AUTH & SESSIONS ===
- POST /api/login (session_token in DB + cookie; single-session enforcement: new login invalidates old)
- POST /api/logout, GET /api/me, POST /api/change-password, PUT /api/profile
- POST /api/forgot-password {identifier=username|email} → reset_token (1h) → mail.sendReset
- GET /api/reset/info?token=, POST /api/reset-password {token,new_password}
- POST /api/forgot-username {identifier=email|phone} → mail.sendUsername (v3.3, no-enumeration)
- Login page: small "Forgot username?" / "Forgot password?" buttons under password (v3.3)

=== ALL API ROUTES (complete list) ===
Core:  GET/POST /api/contacts, PUT/DELETE /api/contacts/:id
       GET/POST /api/loads, PUT/DELETE /api/loads/:id
       GET/POST /api/loads/:id/documents, GET/DELETE /api/documents/:id
       GET /api/performance (?period=&carrier_id=), GET /api/settings/integrations
       POST /api/ai/draft, POST /api/mail/send {to,subject,body} (Templates direct send)
Google: GET /auth/google, GET /auth/google/callback, POST /api/google/disconnect
Admin:  GET/POST /api/users, POST /api/users/:id/reset-password, GET /api/mail/accounts|search|read
DAT:    GET /api/dat/search, POST /api/dat/outreach, GET /api/dat/outreach, POST /api/dat/outreach/poll
Voice:  POST /api/voice/call {load}, GET /api/voice/calls, POST /api/voice/:id/join,
        POST /api/voice/:id/end, GET /api/voice/twilio/voice (TwiML, public), POST /api/voice/twilio/status (public)
        WS /api/voice/ws?callId= (Twilio media stream bridge), WS /api/voice/ws/live?callId= (listen relay)
AI:     POST /api/ai/chat {message}, GET /api/ai/chat ({history,prefs}), POST /api/ai/prefs/remove {key}
Negotiation: POST/GET /api/negotiation/campaigns, GET /api/negotiation/campaigns/:id,
        POST /api/negotiation/campaigns/:id/pause|resume, POST /api/negotiation/threads/:id/approve
Auth flow routes above.

=== GOOGLE INTEGRATIONS ===
- OAuth consent: External/testing mode; each user's Gmail must be a test user; redirect
  https://dat-one.onrender.com/auth/google/callback; scopes drive, sheets, gmail.send, gmail.readonly
- Drive: uploads on document add → "Dispatch Hub" folder; drive_file_id stored; sheet link updated
- Sheets: "Dispatch Loads" spreadsheet, 4 tabs (Loads/Carriers/Drivers/Brokers), idempotent UPSERTs
- Gmail: gmailSend (drafts/bots/outreach/templates), gmailSearchMessages (reply polling, Inbox Monitor)
- NOTE: tokens stored per user; scope change requires disconnect+reconnect (Inbox Monitor note)

=== EMAIL SYSTEM (services/mail.js) ===
- sendInvite (new users), sendReset (forgot password), sendUsername (forgot username)
- Strategy: SMTP (SMTP_HOST/PORT/SECURE/USER/PASS, MAIL_FROM) → any connected Gmail → {status:'skipped'}
- Never throws; returns {status, reason}; UI toasts the reason (no_email/no_smtp_no_gmail/etc.)

=== DAT LOAD BOARD (services/dat.js) ===
- LIVE mode with DAT_API_TOKEN (Bearer) or DAT_USERNAME+DAT_PASSWORD (Basic); configurable
  DAT_BASE_URL/DAT_LOAD_SEARCH_PATH/DAT_METHOD (CONFIRM against DAT portal docs)
- Any API error → demo fallback (realistic loads, seed changes every 15s)
- normalizeLoad() extracts: id, age_min, origin, destination, equipment, miles, rate, rpm, dh_o, dh_d,
  weight, length, broker, contact, ref, extension, broker_email, comments (v2.6, defensive field variants)
  NOTE: DAT standard API usually lacks broker email/comments (paid add-ons) — UI falls back to voice call
- UI: 3 independent search tabs, 25 equipment types, full filters, auto-refresh 5s + badge,
  row actions: Book | ✉️ Email (if email) | 📞 Call (if phone); fleet-pref chips (📌)
- marketRatesForLane() queries the board (rate_desc) for the lane → voice target/floor

=== AI DRAFTS + SHARED CHAT HELPER (services/ai.js) ===
- draft({kind,...}) — inquiry/negotiate/book/checkcall; template fallback; variety seeds + temp 0.6-1.2
- chatCompletion(messages, temp) — SHARED helper (v4.1):
  • apiBase(): OPENAI_BASE_URL or default; Gemini URL gets /v1beta/openai appended automatically
  • model candidates: OPENAI_MODEL → host defaults (groq: llama-3.1-8b-instant; gemini: gemini-2.0-flash;
    openai: gpt-4o-mini) → fallback lists per host; 404/400 retries next model; 401/network stops
- Recommended free AI: Groq (console.groq.com): OPENAI_BASE_URL=https://api.groq.com/openai/v1,
  OPENAI_MODEL=llama-3.1-8b-instant; or Gemini OpenAI-compat endpoint

=== EMAIL NEGOTIATION BOTS (services/negotiator.js) ===
- Campaigns → threads → messages; polls every 5 min; state machine decideNextAction
  ({replyText,minRate,targetRate,round,maxRounds}) → accept|counter|end; never below min_rate
- auto_send=0 → drafts need human Approve; agreement → thread 'agreed' → Book via UI
- UI: AI Negotiations page (💬); owner-scoped; uses gmailSend/gmailSearchMessages

=== DAT OUTREACH (services/outreach.js) ===
- emailBrokerFromLoad({ownerId, load, subject?, body?}) — AI-compose (editable preview) → owner Gmail →
  dat_outreach row; never throws, returns {ok,status,reason,message}
- pollReplies (5-min sweep + manual) via from:<broker> in:inbox newer_than:72h → status 'replied'

=== VOICE AGENT v3 (services/voice.js — Twilio + Gemini Live, NO Vapi) ===
Architecture: Twilio number → outbound call puts BROKER in conference room_{callId} →
Media Stream attached to broker participant (POST /Conferences/{sid}/Participants/{psid}/Streams —
the ONE place to verify against the user's Twilio account) → WS /api/voice/ws → Gemini Live
(BidiGenerateContent, GEMINI_API_KEY) as EXPERT FREIGHT DISPATCHER.
Flow: POST /api/voice/call {load} → market research (lane top rate → target; floor=90%) →
fleet prefs from ai_prefs → insert voice_calls → Twilio REST /Calls.json (SendDigits for ext,
Record=true, status callbacks) → TwiML dials conference → conference join event attaches stream →
Gemini speaks → live transcript (agent=Gemini text, broker=Deepgram STT optional) →
negotiation detection (reuse decideNextAction) sets needs_human → UI alert → POST /:id/join
dials VOICE_FORWARD_TO into the room, agent audio cut → recording_url stored → Call Log playback.
Script (v3.2): opens straight on the load; writes down details, re-asks missed bits; timing
positioning near pickup, ≤30min discrepancies → "we'll be there before that" + [⚠ ETA] transcript
notes; rate script "what's your best boss/sir" → typing sounds ("let me check with the driver") →
"they asked for $X, can you make it" → push more → [Step N] ladder in transcript; handoff
"Okay, let me connect you with my fleet manager for this one"; "are you an AI?" → answers as a
human would (VOICE_AI_DISCLOSE=1 = transparent). Ambient room tone (VOICE_AMBIENT_LEVEL 0.035).
Voice rotation: GEMINI_VOICE comma list (default Puck,Charon,Kore,Fenrir,Leda,Zephyr).
Webhook signature: x-vapi-secret REMOVED — now Twilio status callbacks (no secret; log + update).

=== AI FLEET ASSISTANT (services/ai-chat.js) ===
- Chat page teaches fleet prefs: truck MCs per area, preferred rates, weight/length, dates/times,
  per truck/driver/owner/dispatcher. Extraction: model ends reply with "PREFS_JSON: {…}" anywhere
  (v4.1 fixed anchor bug) → server merges into ai_prefs + strips from shown reply; offline regex
  fallback (MC/$ per mi/lbs/ft/city). Prefs injected into EVERY voice call as FLEET PREFERENCES.

=== PERSISTENCE (db.js, v3.3) ===
- TURSO_DATABASE_URL (+TURSO_AUTH_TOKEN) → hosted libSQL via @libsql/client; wrapper exposes
  run/all/get/exec with variadic AND array param normalization (toArgs — v3.3 bug fix: the `sqlite`
  package accepts get(sql, a) variadic; passing a bare string to libsql args PANICS the Rust core)
- Unset → local SQLite data/dispatch.db (wiped by Render free tier — that's why Turso matters)
- Netlify CANNOT host this app (static host). Alternatives: Turso free 9GB (chosen) | Render disk.

=== MOBILE + PWA + STORES ===
- Mobile (v3.4): ☰ hamburger → off-canvas sidebar (<900px) + backdrop; compact cards; DAT rotate hint
- PWA: manifest.json + sw.js + icons; installable
- Capacitor 7 (v4.0): android/ + ios/ projects generated+synced; capacitor.config.json
  (appId app.datone.mobile, webDir public, https-only); index.html injects window.API_BASE when
  native (→ https://dat-one.onrender.com); api() + live-listen WS honor API_BASE
- APP_STORE_GUIDE.md: Play Store $25 (no Mac) via bundleRelease; App Store needs Mac + $99/yr
- KNOWN: Google OAuth inside native webview may be blocked — fix later w/ Capacitor Browser plugin

=== FRONTEND PAGES (sidebar) ===
Dashboard (charts), Loads, Contacts (Brokers/Carriers/Drivers tabs), DAT Board, Negotiations 💬,
Outreach 📧, Call Log 📞 (live control room), AI Chat 🤖, Templates ✉️, Mail (admin only), Settings
Mobile menu closes on page change; per-page renderers in app.js pageRenderers map.

=== ENV VARS (complete — .env.example mirrors this) ===
Core: PORT, DATA_DIR, SESSION_SECRET, ADMIN_PASSWORD, DISPATCHER_PASSWORD, APP_BASE_URL
Persistence: TURSO_DATABASE_URL (libsql://…turso.io), TURSO_AUTH_TOKEN
Google: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
SMTP: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM
AI: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
DAT: DAT_API_TOKEN | DAT_USERNAME+DAT_PASSWORD, DAT_BASE_URL, DAT_LOAD_SEARCH_PATH, DAT_METHOD
Voice: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, GEMINI_API_KEY, GEMINI_MODEL,
       GEMINI_VOICE, DEEPGRAM_API_KEY (opt), VOICE_AMBIENT_LEVEL (0.035), VOICE_AI_DISCLOSE (0|1),
       VOICE_FORWARD_TO, COMPANY_NAME (static); NOT env: MC_NUMBER, VOICE_TRUCK_CITY, VOICE_ETA_MIN
       (per-truck/dynamic → teach in AI Chat; also render.yaml lists VOICE_TRUCK_CITY/ETA_MIN as legacy-optional)
USER'S RENDER STATE: TWILIO_*, GEMINI_*, DEEPGRAM_API_KEY, TURSO_* SET. SMTP/OPENAI* unset→check.

=== BUGS FIXED (do not reintroduce) ===
1. Dashboard charts full-page tall → maintainAspectRatio:true, maxHeight:220px
2. Carrier dispatch % not auto-calc'ing fee → change listener on carrier_id + rate input
3. Google "Connected" from stale rows → userStatus() requires refresh_token
4. redirect_uri_mismatch → registered callback in Google Console
5. 403 access_denied → user added as test user in OAuth consent
6. Old "Dispatch Loads" spreadsheet lacks v2.1 headers → rename/delete once to recreate
7. Inbox Monitor scope → gmail.readonly added; users must reconnect once
8. mu-law codec bugs → classic encoder (sign mask + BIAS) + decoder masked to 8-bit (~buf[i])&0xFF
9. libsql Rust panic → variadic params normalized via toArgs (see Persistence)
10. AI chat 404 → host-aware model fallback in chatCompletion (see AI section)
11. PREFS_JSON extraction anchored to line start → find anywhere + strip from reply
12. getDb ReferenceError in db.js migration → use local `db`, not the getter

=== KNOWN LIMITATIONS ===
- Render free: 50s cold start; local disk ephemeral (Turso fixes data)
- Google OAuth testing mode: each new Gmail must be added as test user
- DAT real API: field names/paths must be confirmed against DAT portal docs
- Broker-side transcript requires DEEPGRAM_API_KEY; dispatcher words not transcribed
- attachStreamToParticipant path is the one place to verify on the user's Twilio account
- Google OAuth inside Capacitor webview may need the Browser plugin for store versions

=== DEPLOY WORKFLOW ===
1. git add . && git commit -m "msg" && git push origin main (or GitHub Desktop)
2. Render auto-deploys on push; never commit node_modules/, data/, .env
3. PUSH IS PENDING — Render still runs the old Aug-22 build until the user pushes
4. Rookie instructions in ROOKIE_GUIDE.md (§2 push, §3 Twilio, §4 AI Studio, §5 Deepgram, §6 Render env, 6b Turso, 6c SMTP)

=== VERSION HISTORY (condensed — do not revert later features) ===
v2.1  Loads broker/driver autofill + Sheets headers; dashboard analytics (period/carrier scope)
v2.2  Invite emails (mail.js, nodemailer, SMTP→Gmail fallback)
v2.3  Live DAT API path + demo fallback; 3-tab DAT board; email reliability; PWA install
v2.4  Admin Inbox Monitor (gmail.readonly, /api/mail/*, Mail page)
v2.5  AI template variety; email negotiation bots (negotiator.js + 💬 page); voice scaffold
v2.6  DAT row contact data (ref/ext/email/comments); outreach.js (✉️ Email broker); Vapi voice (later dropped)
v3.0  Voice rebuilt: Twilio + Gemini Live (no Vapi); conference+stream bridge; live transcript,
      needs_human alerts, Take Over (VOICE_FORWARD_TO into room), recordings, live listen, market research
v3.1  Human voice: ambient room tone (VOICE_AMBIENT_LEVEL), speech directives, curated voices
v3.2  Dispatcher's exact call script; typing sounds; [Step N] ladder; [⚠ ETA] checks; fleet-manager handoff
v3.3  Forgot username + forgot password buttons; Turso hosted-DB persistence; SMTP docs
v3.4  Mobile off-canvas menu; AI Fleet Assistant (chat + prefs into voice); templates direct send
v4.0  Capacitor app-store prep (android/ + ios/ projects, API_BASE wiring, APP_STORE_GUIDE)
v4.1  AI 404 fix: host-aware model fallback (chatCompletion); PREFS_JSON extraction fix

=== NEXT STEPS — USER ACTIONS (checklist) ===
[ ] PUSH TO GITHUB (critical, blocks everything): unzip datone-latest.zip → GitHub Desktop →
    Add Local Repository → Commit → Push. Render then auto-deploys the real app.
[ ] Verify deploy: Render dashboard shows "Live"; https://dat-one.onrender.com shows new login
[ ] Test forgot password/username: log out → click both buttons → enter admin email → check inbox
    (needs SMTP set or any connected Google; see ROOKIE_GUIDE §6c for Gmail App Password)
[ ] Verify Turso persistence: add a driver → force a restart (Render → Restart) → driver still there
[ ] Test voice: DAT Board → Search → 📞 Call → watch Call Log live transcript; test Take Over (cell rings)
[ ] Confirm Twilio Streams path on the user's account (attachStreamToParticipant in services/voice.js)
[ ] Add COMPANY_NAME (optional; agent intro) — leave MC_NUMBER/VOICE_TRUCK_CITY/VOICE_ETA_MIN unset
[ ] Check OPENAI_* (AI drafts + chat): if using Groq set BASE_URL+MODEL; fallback handles wrong models
[ ] Re-teach fleet prefs in AI Chat (Symone message etc. were lost pre-fix — re-send after deploy)
[ ] Android store: npm run cap:build:android → upload AAB to Play Console ($25) — APP_STORE_GUIDE §2
[ ] iOS store: needs Mac + Xcode + $99/yr — APP_STORE_GUIDE §3; OAuth Browser plugin before submission
[ ] Consider: real DAT API credentials from DAT portal (fields/paths to confirm), custom domain

=== FUTURE IDEAS (not built) ===
- Driver/truck "current location" field (one-tap update; replaces VOICE_TRUCK_CITY guesswork)
- Capacitor Browser plugin for in-app Google OAuth (store review requirement)
- Offline shell / Network plugin for store apps
- Real DAT credit-check add-on fields (broker credit score, days to pay)
- Call cost tracking + per-user monthly totals
- WhatsApp/SMS fallback for broker contact
- Backups/export for Turso data (turso.tech dashboard or CLI)

=== LOGIN CREDENTIALS ===
admin / value of ADMIN_PASSWORD env var (set on Render)
dispatcher / value of DISPATCHER_PASSWORD env var (must change on first login)
