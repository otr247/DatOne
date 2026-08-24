# Google Drive / Sheets / Gmail Setup — NEW Google Account

This guide recreates the Google integration from scratch using your **new** Google
account, new GitHub repo and new Render URL. The app code already supports it —
you only need to configure Google Cloud once, then paste two values into Render.

> All values below use your live URL: `https://dat-one.onrender.com`.

---

## 1. Create a Google Cloud project (with the new account)

1. Go to <https://console.cloud.google.com> and sign in with your **new** Google account.
2. Top bar → project selector → **New Project**.
   - Name: `Dispatch Hub` (or anything you like).
   - Click **Create**, then select the new project in the dropdown.

## 2. Enable the three APIs

Menu → **APIs & Services → Library**. Search and click **Enable** for each:

1. **Google Drive API**
2. **Google Sheets API**
3. **Gmail API**

## 3. OAuth consent screen

Menu → **APIs & Services → OAuth consent screen**.

1. User type: **External** → Create.
2. App name: `Dispatch Hub` · Support email: your new Gmail.
3. **Audience** → **Add users** (this is the critical step):
   - Add the Gmail address(es) of every person who will connect Google from the app.
   - At minimum add **your new Gmail**. Add dispatcher Gmails too — anyone not on
     this list will see `403 access_denied` when clicking "Connect Google".
4. **Scopes** — the app requests these automatically during consent, but adding
   them now makes the screen cleaner:
   - `.../auth/drive.file`
   - `.../auth/spreadsheets`
   - `.../auth/gmail.send`
   - `.../auth/gmail.readonly` (used by the admin-only **Inbox Monitor**)
   - `.../auth/userinfo.email`
   - `openid`
   > **Important:** `gmail.readonly` was added in v2.4 — anyone who connected
   > Google before that must **Disconnect and reconnect once** (the consent screen
   > will show "Read your email"). Old connections lack the read permission until
   > they reconnect; the Inbox Monitor then works for those accounts.
5. Finish and **publish status stays "Testing"** — that is fine. Do NOT click
   "Publish app" / submit for verification (would require a Google review).
   Testing mode + test users is exactly what this app needs.

## 4. Create the OAuth client (Client ID + Secret)

Menu → **APIs & Services → Credentials** → **+ Create Credentials → OAuth client ID**.

- Application type: **Web application**
- Name: `Dispatch Hub Web`
- **Authorized JavaScript origins**:
  - `https://dat-one.onrender.com`
- **Authorized redirect URIs** (must be EXACT — this is the #1 cause of failures):
  - `https://dat-one.onrender.com/auth/google/callback`
- Click **Create** → a dialog shows **Client ID** and **Client Secret**. Copy both.

> `redirect_uri_mismatch` means the URI in Google does not byte-for-byte match
> `GOOGLE_REDIRECT_URI` in Render (no trailing slash, correct domain, https).

## 5. Put the values into Render

In your new Render service → **Environment** (or during first deploy):

| Env var | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the Client ID from step 4 |
| `GOOGLE_CLIENT_SECRET` | the Client Secret from step 4 |
| `GOOGLE_REDIRECT_URI` | `https://dat-one.onrender.com/auth/google/callback` |
| `APP_BASE_URL` | `https://dat-one.onrender.com` |

Then **Deploy** (or Manual Deploy → Clear build cache & deploy if it was already running).

## 6. Connect from the app

1. Open your Render URL, log in (`admin` / your `ADMIN_PASSWORD`).
2. **Settings** → Integrations → **Connect Google**.
3. Sign in with the **new Google account** and click **Allow** (you'll see an
   "unverified app" warning — that's expected in Testing mode; click Advanced →
   Continue).
4. You're redirected back with a green "Google account connected" toast.

## What happens automatically after connecting

- **Sheets**: a spreadsheet named **"Dispatch Loads"** is created in your Drive on
  the first save, with 4 tabs (Loads / Carriers / Drivers / Brokers) and headers.
  The Loads tab now includes **Driver Email** and **Driver Phone** columns.
- **Drive**: a folder named **"Dispatch Hub"** is created; load documents
  (rate cons, POD, BOL…) uploaded in the app are copied there and linked from the
  Loads sheet.
- **Gmail**: the `gmail.send` scope is granted. The app's Templates page currently
  opens the draft in your mail client; sending directly via the Gmail API can be
  wired using the same connection (it's the planned "Send via Gmail" button).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `redirect_uri_mismatch` | Google's redirect URI and `GOOGLE_REDIRECT_URI` must match exactly. |
| `403 access_denied` | That Gmail is not in **OAuth consent screen → Test users**. Add it and retry. |
| "This app is blocked" | Project is in Testing mode and the user isn't a test user (same fix as above). |
| `invalid_client` | Client ID/Secret pasted wrong (extra space, truncated). |
| Sheet columns look wrong / misaligned | You connected with an OLD spreadsheet created by the previous app version. Delete (or rename) the old **"Dispatch Loads"** file in Drive once; the app recreates it with the new headers. |
| Works after deploy, stops later | Free-tier Render restarts reset the SQLite DB unless a persistent disk is enabled (see DEPLOYMENT.md); reconnect Google after restart. |

## Local development

Copy `.env.example` to `.env` and set the same Google values with
`GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback` — then add
`http://localhost:3000/auth/google/callback` to the same Google client's
authorized redirect URIs (you can have both localhost and the Render URL listed).
