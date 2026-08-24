# ROOKIE GUIDE — go from "what is push?" to live voice agent

Written for a total beginner. Follow the sections in order. Everything you need
to make the DAT One app live with the AI voice agent, explained like you're new.

---

## 1. First, the big picture (what all these pieces are)

| Thing | What it is | You need it for |
|---|---|---|
| **GitHub** | The online "cloud" where your app's code lives (repo = folder of code). Your repo is `otr247/DatOne`. | Storing the code + triggering deployments |
| **git push** | The act of *uploading your newest code* from your computer to GitHub. "Push" = push it up. | Every time we change the app, you push, and the live app updates |
| **Render** | The hosting company that RUNS your app on the internet (free tier). | Making https://dat-one.onrender.com work |
| **Auto-deploy** | Render watches GitHub; the moment you push, it re-builds and updates the live app automatically. | You never deploy manually |
| **Env vars (environment variables)** | Secret settings (keys, passwords) stored on Render, NOT in the code. Like a settings locker. | The app reads them to talk to Twilio/Google/etc. |
| **Twilio** | A phone company for developers. You buy a phone number from them. | The number your AI agent calls brokers from |
| **Google AI Studio** | Google's free developer console. Gives you an API key for the Gemini AI voice brain. | The AI voice itself |
| **Deepgram (optional)** | A speech-to-text service (free tier) that transcribes what the broker says live. | Showing the broker's side of the conversation as text |

The chain: **your computer → git push → GitHub → Render auto-deploy → live app**.
The live app calls brokers using **Twilio number + Gemini voice + (optional) Deepgram transcription**.

---

## 2. What "push" actually means (with an analogy)

Imagine your app is a Word document. You edit it on your computer (that's the
code). "Push" = saving the latest version to the cloud (GitHub), and Render is
a printer that instantly prints the newest version to the website.

**When do you push?** Whenever we (or you) change the app code. Then the live
app updates by itself 2–5 minutes later.

### How to push — pick ONE method (the easiest is GitHub Desktop)

**Option A: GitHub Desktop (easiest, no typing)**
1. Download and install GitHub Desktop → https://desktop.github.com
2. Open it → sign in with your GitHub account (the one that owns `otr247/DatOne`)
3. File → Clone repository → pick `otr247/DatOne` → choose a folder on your computer
   (now you have the app's code on your computer)
4. When you have new code: copy the changed files into that folder
5. In GitHub Desktop you'll see the changes listed → bottom-left box: type a
   message (e.g. "voice update") → click **Commit to main**
6. Click **Push origin** (top bar). Done — Render starts deploying.

**Option B: VS Code (also easy)**
1. Install VS Code → open the cloned project folder
2. Click the branch icon (Source Control) on the left
3. Type a message → click ✓ (commit) → click "Push"

**Option C: Terminal (the old-school way)**
```bash
cd path/to/DatOne
git add .
git commit -m "voice update"
git push origin main
```
If it asks for username/password: username = your GitHub username, password =
a **Personal Access Token** (not your normal password). Create one at
github.com → Settings → Developer settings → Personal access tokens →
Generate new (classic) → tick "repo" → copy it, paste as password.

### How do you know it worked?
- GitHub Desktop shows "Published/Pushed", or terminal shows no errors
- https://github.com/otr247/DatOne → "commits" shows your new commit
- https://dat-one.onrender.com → Render's dashboard shows "Deploying…" then "Live"

---

## 3. Twilio — buy your phone number (~10 minutes)

1. Go to https://www.twilio.com → **Sign up** (free trial; they may ask for a
   phone number to verify — that's normal)
2. After signing in you land on the Console. Look at the top of the page — you'll
   see two codes:
   - **ACCOUNT SID** (starts with `AC…`)
   - **AUTH TOKEN** (starts with the same letters; click the eye to reveal it)
   - ⚠ Copy both somewhere safe — these are like your password.
3. Buy a number: Console → **Phone Numbers → Manage → Buy a number**
   - Pick a country (US if your brokers are US)
   - Pick any number (they cost about **$1.15/month**)
   - Check "Voice" is enabled → Buy
4. **Voice settings for that number** (important!): go to Phone Numbers → your
   number → scroll to **Voice & Fax** → "When a call comes in" → set Webhook to:
   ```
   https://dat-one.onrender.com/api/voice/twilio/voice
   ```
   Actually — for OUTBOUND calls (which is all we make) this setting isn't even
   used, but set it anyway so inbound calls don't break. Our app dials out via
   the API, so this is just a safety net.
5. Top up a few dollars — trial balance works to test, but for real calls add
   ~$10–20 (calls cost roughly **1–2 cents per minute**).

**Keep these three values for Section 6:** `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, and your new number (format `+12125550123`).

---

## 4. Google AI Studio — get the free Gemini key (5 minutes)

1. Go to https://aistudio.google.com → sign in with any Google account
2. Click **Get API key** (left sidebar) → **Create API key**
   - If it asks to pick a Google Cloud project, just create one (name it anything)
3. Copy the key (starts with `AIza…`). It's free-tier; for live calls you may
   add billing later if you exceed the free quota — cost is tiny (about
   **2–5 cents per minute** of AI voice).

**Keep this value for Section 6:** `GEMINI_API_KEY`.

---

## 5. Deepgram (OPTIONAL — but do it, it's free and cool)

Deepgram transcribes what the BROKER says so the transcript shows both sides.

1. Go to https://deepgram.com → Sign up (free tier gives you free credits)
2. Console → **API Keys** → create a key (starts with a long random string)
3. That's it. If you skip this, the transcript still shows the agent's side
   plus all the [Step] and [⚠ ETA] notes — just not the broker's exact words.

**Keep this value for Section 6:** `DEEPGRAM_API_KEY` (optional).

---

## 6. Put everything into Render (the "settings locker") — 10 minutes

1. Log in to https://dashboard.render.com (same account that owns the app)
2. Find your service: **dat-one** → **Environment** (left menu)
3. Click **Add Environment Variable** and add these (name → value):

| Name | Value (example) |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://yourdb-org.turso.io` — **stops data loss** (see 6b) |
| `TURSO_AUTH_TOKEN` | `eyJ…` (long token from Turso) |
| `SMTP_HOST` | e.g. `smtp.gmail.com` — makes reset/username emails send (see 6c) |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | your sender email address |
| `SMTP_PASS` | your app password (not your normal password) |
| `TWILIO_ACCOUNT_SID` | `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_AUTH_TOKEN` | `xxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_FROM_NUMBER` | `+12125550123` (your Twilio number) |
| `GEMINI_API_KEY` | `AIzaSy…` (from AI Studio) |
| `GEMINI_MODEL` | `gemini-2.5-flash-live` |
| `GEMINI_VOICE` | `Puck,Charon,Kore,Fenrir,Leda,Zephyr` |
| `DEEPGRAM_API_KEY` | *(optional)* your Deepgram key |
| `MC_NUMBER` | your motor carrier number, e.g. `123456` |
| `COMPANY_NAME` | your company name, e.g. `Swiftline Dispatch` |
| `VOICE_FORWARD_TO` | YOUR cell phone, e.g. `+19175550123` — this is what "Take Over" dials |
| `VOICE_AMBIENT_LEVEL` | `0.035` (or `0` to turn the room-tone off) |
| `VOICE_AI_DISCLOSE` | `0` (or `1` if you want it to admit being an AI) |
| `VOICE_TRUCK_CITY` | *(optional)* e.g. `Chicago, IL` — where the truck currently is |
| `VOICE_ETA_MIN` | *(optional)* e.g. `45` — minutes from now to the pickup |

4. Click **Save Changes** — Render restarts the app with the new settings.

> Already-set vars you should check are still there: `SESSION_SECRET`,
> `ADMIN_PASSWORD`, `APP_BASE_URL` (= `https://dat-one.onrender.com`),
> `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` (for the
> Gmail/Sheets stuff).

---

## 6b. STOP LOSING YOUR DATA (free fix — do this one!)

**Why your app "forgets" everything:** Render's free plan has no permanent
storage — the app's database file lives on a throwaway disk that gets wiped
every time the app restarts (about every ~15 min of inactivity, and on every
deploy). That's why sheets links, drivers, loads, users all reset.

**Why Netlify can't help:** Netlify is a *static* hosting service (websites,
pages). This app needs a live always-running server, WebSockets, and a database
— Netlify runs none of those. It's the wrong tool here.

**The free fix — Turso (a hosted database, 9GB free):**
1. Go to https://turso.tech → **Sign up** (GitHub or Google login, 1 minute)
2. Click **Create database** → name it anything (e.g. `datone`) → the region can
   be `us-east` — Create
3. On the database page click **Generate Token** (or *Tokens*) → pick
   "Read-Write" → copy the long token (starts with `eyJ…`) — shown once!
4. Copy the **database URL** (looks like `libsql://datone-username.turso.io`)
5. Add both to Render (see the table in Section 6):
   - `TURSO_DATABASE_URL` = that URL
   - `TURSO_AUTH_TOKEN` = that token
6. Save → Render restarts → from now on ALL data lives in Turso's cloud and
   survives every restart, deploy, and downtime. Done — forever.

> The app automatically uses Turso when those two vars are set; otherwise it
> falls back to the local file. No code changes needed.

## 6c. Make the "forgot password / forgot username" emails actually send

The buttons now exist on the login screen (small, under the password box), and
the app will email a reset link or the username — but **only if email sending
is configured**. Two ways (either works):

**Option 1 — SMTP (recommended, 5 min):** use any free SMTP account.
- Gmail: enable 2-step verification, then create an **App Password**
  (myaccount.google.com → Security → App passwords → create, 16-char code).
  Then on Render: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=you@gmail.com`,
  `SMTP_PASS=<the 16-char app password>`, `MAIL_FROM=you@gmail.com`.
- Or Brevo/Resend/etc. — same pattern, just different host/port.
**Option 2 — no SMTP:** have ANY user connect Google in the app (Settings →
Connect Google). The app then sends reset/username emails from that connected
Gmail as a fallback. Works, but only while that account stays connected.

**How to test:** open the login page → click "Forgot password?" → enter your
username → check the inbox (and spam). The link expires in 1 hour.

## 7. Test it (5 minutes)

1. Open https://dat-one.onrender.com → log in (admin / your ADMIN_PASSWORD)
2. Go to **DAT Board** → click **Search** → any load row with a phone number →
   click **📞 Call**
3. Your Twilio number calls the broker. Watch **Call Log** (📞 in the sidebar):
   - Agent's words appear in blue, broker's in green (if Deepgram is set)
   - Amber **[Step]** lines = the rate ladder (what was offered vs. our target)
   - Red **[⚠ ETA]** lines = timing checks
   - When it gets close to booking, a red banner + browser notification pops:
     click **👤 Take Over** — YOUR phone rings into the live call
   - After the call: **▶ Recording** plays the whole thing back
4. No call going out? Check Render → Logs for the error (usually a missing key).

---

## 8. Everyday workflow (after setup)

1. We change the code → commit to `main` on GitHub (via GitHub Desktop / VS Code)
2. Render auto-deploys in a few minutes
3. You open the app, hit 📞 Call, watch the transcript, take over when alerted
4. If a new key is needed → add it in Render → Environment → Save (no code change)

---

## Troubleshooting cheat-sheet

| Problem | Likely cause | Fix |
|---|---|---|
| "Voice AI is not configured" | One of TWILIO_* / GEMINI_API_KEY missing on Render | Add it in Render → Environment → Save |
| Call fails instantly | AUTH_TOKEN wrong, or number not bought | Re-copy from Twilio console; check the number exists |
| No broker text in transcript | DEEPGRAM_API_KEY missing/expired | Add it; it's optional so the call still works |
| "Take Over" does nothing | VOICE_FORWARD_TO empty | Set it to your cell number in E.164 (+1…) |
| App outdated after push | Deploy failed | Render dashboard → deploy log; usually a missing env var |
| Push asks for password | GitHub needs a token | Use a Personal Access Token (see Section 2, Option C) |
