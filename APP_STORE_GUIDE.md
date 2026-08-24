# APP STORE GUIDE — get DAT One into the Play Store & App Store

The app is wrapped with **Capacitor** (Android + iOS native projects). The app
itself runs on your Render backend; the store apps are a native shell around it.

**How the app projects work — nothing is ever lost:**
The `android/` and `ios/` folders are GENERATED from `capacitor.config.json` +
`package.json` + the `public/` web app. They are intentionally NOT uploaded with
the website (that's why the web zip is small). To recreate them at any time,
on any computer with Node.js:
```bash
cd DatOne
npm install
npm run cap:gen      # = npx cap add android; npx cap add ios; npx cap sync
```
This produces the identical native projects. So store-readiness lives in the
repo's config — there is nothing to "skip" or "miss", and you can do this later
when you're ready (no Mac needed for Android).

**The honest basics first:**
- **Android (Play Store):** $25 one-time fee, no Mac required. ~1–2 hours.
- **iOS (App Store):** requires a **Mac** (for Xcode), an **Apple Developer
  account ($99/year)**, code signing, and Apple's review. Plan 1–2 days.
  Until you have a Mac: iPhone users can open the site and use **Share →
  Add to Home Screen** for a full-screen app with an icon.

---

## 1. Before you start (both stores)

1. Push the app to GitHub (see ROOKIE_GUIDE §2) — Render deploys it live.
2. Make sure the app is fully working on https://dat-one.onrender.com.
3. Have your brand assets ready:
   - App icon **1024×1024** PNG (your DAT One logo, no rounded corners on
     iOS — Apple adds them itself; Android needs adaptive icons, Capacitor
     generates those from your 1024 icon)
   - Splash/launch screen (Capacitor generates from your icon too)
   - A short description + screenshots (phone screenshots: 6.5" and 5.5",
     and a tablet one for Android)
   - A **privacy policy URL** (both stores require one — you can put a
     simple page on your site, e.g. /privacy; or a Google Doc link)

---

## 2. ANDROID — Play Store (no Mac needed)

### 2a. Build the app (on any computer with the repo + Node)
```bash
cd DatOne
npm install
npx cap sync android          # copy latest web code into the Android app
cd android
./gradlew assembleRelease     # or: ./gradlew assembleDebug to test first
```
The signed-ready file (debug APK) appears in `android/app/build/outputs/apk/debug/`.
For the real release you need a signing key:
```bash
keytool -genkey -v -keystore datone.keystore -alias datone -keyalg RSA -keysize 2048 -validity 10000
```
Set it in `android/app/build.gradle` (signingConfigs + release buildType) — or
skip local signing and let Google handle it with **Play App Signing** (Google
gives you the key management; you upload an unsigned release build). Easiest
for beginners: use Play App Signing.

### 2b. Publish
1. Go to https://play.google.com/console → **Create app** (pay the one-time **$25**)
2. Fill the store listing: name, short description, long description, icon,
   screenshots, feature graphic, privacy policy URL, category (Business)
3. **Production → Create new release** → upload the **AAB** file
   (`./gradlew bundleRelease` produces `android/app/build/outputs/bundle/release/`)
4. Set up **Play App Signing** when it asks (recommended)
5. Review → **Roll out to production** (or start with a 10% staged rollout)
6. Review takes a few hours to a few days. Done.

> Tip: you can install the debug APK on your own Android phone right away
> (Settings → allow "install unknown apps") to test before publishing.

---

## 3. iOS — App Store (requires a Mac)

### 3a. Prerequisites (all on the Mac)
1. **Xcode** — install from the Mac App Store (free, ~12 GB)
2. **Apple Developer account** — https://developer.apple.com → enroll → **$99/year**
3. **Node.js** on the Mac (LTS) + the repo folder (clone or copy it over)

### 3b. Build
```bash
cd DatOne
npm install
npx cap sync ios              # copy web code into the iOS app
npx cap open ios              # opens the Xcode project
```
In Xcode:
1. Select the **DAT One** target → **Signing & Capabilities** → check
   "Automatically manage signing" → select your Apple Developer team
   (Xcode creates the certificates/provisioning profile for you)
2. Change the **Bundle Identifier** if you want (default `app.datone.mobile`)
3. Plug in an iPhone → hit **Run** (▶) to test on a real device first

### 3c. Submit
1. In Xcode: Product → **Archive**
2. Window → **Organizer** → select the archive → **Distribute App** →
   App Store Connect → Upload
3. Go to https://appstoreconnect.apple.com → your app → add the same listing
   details (name, description, screenshots, privacy policy, category)
4. Submit for **Review**

### 3d. App Store review — things Apple checks for web-wrapped apps
- ✅ App must work when launched (it does — connects to your Render backend)
- ✅ Must not be "just a website in a browser" — a native splash, icon, and
  real in-app functionality (which you have: chat, calls, emails, board) help
- ✅ Privacy policy link required; mention data usage (email, contacts) in the
  privacy section
- ⚠️ **Google OAuth inside the app**: currently the "Connect Google" flow
  opens in the app's built-in webview, which Apple/Google may block. For the
  store versions, the recommended fix is the **Capacitor Browser plugin**
  (opens OAuth in the system browser). Note: admin features work without it —
  most users just log in with username/password, so the app is fully usable.
- ⚠️ Reviewers test on Wi-Fi; the app needs the network for data. If offline
  is critical later, we can add the Capacitor Network plugin + offline shell.

### 3e. After approval
The app appears in the App Store. Every time you push new code to GitHub:
```bash
cd DatOne && npx cap sync ios && npx cap open ios   # re-archive + submit
```

---

## 4. Keeping both apps in sync with new versions
Workflow per update:
1. Push code to GitHub (Render redeploys the backend automatically)
2. On your machine: `npx cap sync android ios` (copies the new web build)
3. Android: rebuild `bundleRelease` → upload to Play Console (staged rollout)
4. iOS: re-archive in Xcode → upload → submit for review

---

## 5. Cost summary
| Item | Cost |
|---|---|
| Google Play developer account | $25 once |
| Apple Developer account | $99/year |
| Twilio number | ~$1.15/month |
| Gemini AI voice | ~$0.02–0.05/min (free tier first) |
| Turso database | Free tier (9 GB) |
| Render hosting | Free tier |
| Xcode (Mac) | Free (Mac itself: needs one for iOS) |
