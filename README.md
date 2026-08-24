# DAT One — Dispatch · Paperwork · Profit

## What you need to do after downloading this zip

### Step 1 — Add the two icon files
Save the DAT One logo image as TWO files inside the `public/` folder:
- `public/icon-192.png`
- `public/icon-512.png`

Image URL (right-click → Save As):
https://sc04.alicdn.com/kf/S19ff90ef7b2b44b29b03e4990a0121b7x.jpg

Save it twice — same image, two different filenames.

### Step 2 — Add your app.js and styles.css
Your existing `app.js` and `styles.css` from the previous version go into `public/`.
They are NOT included in this zip (they haven't changed).

### Step 3 — Add your services/ folder
Your existing `services/google.js`, `services/dat.js`, `services/ai.js` go in the `services/` folder.
They are NOT included in this zip (they haven't changed).

### Step 4 — Push to GitHub
```
git add .
git commit -m "DAT One PWA + single session enforcement"
git push
```

Render auto-deploys. Done.

---

## What's new in this version
- Rebranded to **DAT One** (Dispatch · Paperwork · Profit)
- DAT One logo in login screen, sidebar, and install banner
- PWA installable: users can install as desktop/phone app
- Single session enforcement: only one login per user at a time
- Session kicked modal: shows when another device logs in
