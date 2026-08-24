# DAT ONE — DO-NOT-MISS CHECKLIST
Everything still to do, in order. Tick them off. Full details in CONTEXT_PROMPT.md / ROOKIE_GUIDE.md / APP_STORE_GUIDE.md.

## 🔴 Step 1 — Push the app (THE critical one — everything else waits on it)
- [ ] Download **datone-latest.zip** from the chat
- [ ] Unzip it (Desktop is fine)
- [ ] Install **GitHub Desktop** (desktop.github.com) → sign in with your GitHub
- [ ] File → **Add Local Repository** → pick the unzipped folder
- [ ] Type a message → **Commit to main** → **Push origin**
- [ ] Check https://github.com/otr247/DatOne shows the new commits
- [ ] Render dashboard → your service shows **Deploying → Live**

## 🟡 Step 2 — Verify the app is alive
- [ ] Open https://dat-one.onrender.com → log in (admin / your ADMIN_PASSWORD)
- [ ] Log out → **Forgot username?** and **Forgot password?** are under the login box
- [ ] Open the site on your PHONE → **☰** hamburger menu slides in/out
- [ ] DAT Board → Search → rows show **Book | ✉️ Email | 📞 Call**

## 🟡 Step 3 — Emails actually sending (reset/username/invites)
- [ ] Either add SMTP on Render (Gmail App Password — ROOKIE_GUIDE §6c) or connect Google in Settings
- [ ] Test: Forgot password → enter your username → check inbox + spam

## 🟡 Step 4 — Data stops resetting (Turso)
- [ ] Confirm `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` are on Render (you added these ✅)
- [ ] Test: add a driver → Render → **Restart** service → driver still there = persistence works

## 🟡 Step 5 — Voice agent go-live
- [ ] Confirm TWILIO_* + GEMINI_API_KEY on Render (done ✅)
- [ ] Add `VOICE_FORWARD_TO` = your cell (E.164, e.g. +19175550123) — required for **Take Over**
- [ ] Add `COMPANY_NAME` (optional, agent intro)
- [ ] DAT Board → 📞 Call on a load → Call Log shows live transcript
- [ ] When the alert pops → **👤 Take Over** → your phone rings into the call
- [ ] After a call → **▶ Recording** plays back

## 🟡 Step 6 — AI Fleet Assistant
- [ ] AI Chat (🤖) → tell it: "Truck 7 MC is 123456, preferred rate $2.10/mile for the Chicago area"
- [ ] Confirm the pref appears under **Saved preferences**
- [ ] (If you get an AI error → check OPENAI_* env; the app now auto-falls-back to a working model)

## 🟢 Step 7 — App stores (only after Step 1)
- [ ] **Android:** npm run cap:build:android → upload .aab to Play Console ($25 once) — no Mac needed
- [ ] **iOS:** needs a Mac + Xcode + Apple Developer ($99/yr) — APP_STORE_GUIDE §3
- [ ] Before iOS submission: add Capacitor Browser plugin for Google OAuth (tell the AI to do it)
- [ ] iPhone users without a store app yet: site → Share → **Add to Home Screen**

## 💡 Later (optional)
- [ ] Real DAT API credentials (field names/paths to confirm in DAT portal)
- [ ] Driver "current location" field in the app (one-tap truck position updates)
- [ ] Custom domain
