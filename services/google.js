// services/google.js — PER-USER Google OAuth (Drive / Sheets / Gmail)
// Each user connects their OWN Google account. Tokens are stored per user in the DB.
//
// Google Sheet structure ("Dispatch Loads"):
//   Tab "Loads"    — one row per load, Document Links column lists Drive file URLs
//   Tab "Carriers" — one row per carrier, linked to loads via carrier name
//   Tab "Drivers"  — one row per driver, linked to carrier name
//   Tab "Brokers"  — one row per broker
//
// All tab operations are upsert (find existing row by key, update; else append).

const { google } = require('googleapis');
const { getDb } = require('../db');

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly', // admin Inbox Monitor (users must re-connect once)
  'https://www.googleapis.com/auth/userinfo.email',
  'openid'
];

const DRIVE_FOLDER_NAME = 'Dispatch Hub';
const SHEET_TITLE      = 'Dispatch Loads';

// ─── Tab header definitions ─────────────────────────────────────────────────
const TAB_HEADERS = {
  Loads: [
    'Load Ref', 'Status', 'Origin', 'Destination', 'Broker', 'Broker Email',
    'Broker Phone', 'Equipment', 'Miles', 'Rate ($)', 'Dispatch Fee ($)',
    'Pickup Date', 'Delivery Date', 'Carrier', 'Driver', 'Driver Email',
    'Driver Phone', 'Notes', 'Document Links', 'Updated At'
  ],
  Carriers: [
    'Name', 'Company', 'Manager', 'Dispatch %', 'Phone', 'Email', 'Notes', 'Updated At'
  ],
  Drivers: [
    'Name', 'Carrier', 'CDL Type', 'Endorsements', 'Truck Unit', 'Truck Type',
    'Length (ft)', 'Weight (lbs)', 'Phone', 'Driver Notes', 'Notes', 'Updated At'
  ],
  Brokers: [
    'Name', 'Company', 'Phone', 'Email', 'Notes', 'Updated At'
  ]
};

// ─── OAuth boilerplate ───────────────────────────────────────────────────────

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUri() {
  return process.env.GOOGLE_REDIRECT_URI
    || `${process.env.APP_BASE_URL || 'http://localhost:3000'}/auth/google/callback`;
}

function makeClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri()
  );
}

function getAuthUrl(state) {
  const client = makeClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: state || ''
  });
}

async function handleCallback(code, userId) {
  if (!code) throw new Error('Missing OAuth code');
  const client = makeClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  let email = null;
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const me = await oauth2.userinfo.get();
    email = me.data.email || null;
  } catch (_) {}
  await saveUserTokens(userId, tokens, email);
  return { ok: true, email };
}

async function saveUserTokens(userId, tokens, email) {
  const db = getDb();
  const extra = JSON.stringify({ email: email || null });
  await db.run(`
    INSERT INTO user_integrations (user_id, provider, access_token, refresh_token, expiry_date, scope, token_type, extra, updated_at)
    VALUES (?, 'google', ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
      expiry_date   = excluded.expiry_date,
      scope         = excluded.scope,
      token_type    = excluded.token_type,
      extra         = excluded.extra,
      updated_at    = datetime('now')
  `, [userId, tokens.access_token || null, tokens.refresh_token || null,
      tokens.expiry_date || null, tokens.scope || null, tokens.token_type || null, extra]);
}

async function loadUserTokens(userId) {
  return await getDb().get(
    'SELECT * FROM user_integrations WHERE user_id = ? AND provider = ?',
    [userId, 'google']
  );
}

async function userStatus(userId) {
  if (!isConfigured()) return { connected: false, email: null };
  const row = await loadUserTokens(userId);
  if (!row || !row.refresh_token) return { connected: false, email: null };
  let email = null;
  try { email = row.extra ? (JSON.parse(row.extra).email || null) : null; } catch (_) {}
  return { connected: true, email };
}

async function disconnectUser(userId) {
  await getDb().run(
    'DELETE FROM user_integrations WHERE user_id = ? AND provider = ?',
    [userId, 'google']
  );
}

async function clientForUser(userId) {
  if (!isConfigured()) throw new Error('Google is not configured on this server');
  const row = await loadUserTokens(userId);
  if (!row) throw new Error('This user has not connected Google yet');
  const client = makeClient();
  client.setCredentials({
    access_token:  row.access_token,
    refresh_token: row.refresh_token,
    expiry_date:   row.expiry_date,
    scope:         row.scope,
    token_type:    row.token_type
  });
  client.on('tokens', async (t) => {
    try {
      const emailVal = row.extra ? JSON.parse(row.extra).email : null;
      await saveUserTokens(userId, { ...t, refresh_token: t.refresh_token || row.refresh_token }, emailVal);
    } catch (_) {}
  });
  return client;
}

// ─── Drive helpers ───────────────────────────────────────────────────────────

async function getOrCreateFolder(driveClient) {
  const res = await driveClient.files.list({
    q: `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive'
  });
  if (res.data.files && res.data.files.length > 0) return res.data.files[0].id;
  const created = await driveClient.files.create({
    requestBody: { name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  return created.data.id;
}

/**
 * Upload a document buffer to the user's Drive → "Dispatch Hub" folder.
 * Returns { fileId, webViewLink } or null on failure.
 */
async function uploadToDrive(userId, filename, buffer, mimeType) {
  try {
    const status = await userStatus(userId);
    if (!status.connected) return null;
    const auth = await clientForUser(userId);
    const driveClient = google.drive({ version: 'v3', auth });
    const folderId = await getOrCreateFolder(driveClient);

    const { Readable } = require('stream');
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);

    const res = await driveClient.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType: mimeType || 'application/octet-stream', body: stream },
      fields: 'id, webViewLink'
    });
    return { fileId: res.data.id, webViewLink: res.data.webViewLink };
  } catch (err) {
    console.error(`[Google Drive] upload failed for user ${userId}:`, err.message);
    return null;
  }
}

// ─── Sheets helpers ──────────────────────────────────────────────────────────

/**
 * Find or create the master spreadsheet, ensuring all 4 tabs exist with headers.
 * Returns spreadsheetId.
 */
async function getOrCreateSpreadsheet(sheetsClient, driveClient) {
  // Look for existing sheet in Drive
  const res = await driveClient.files.list({
    q: `name='${SHEET_TITLE}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive'
  });

  let spreadsheetId;

  if (res.data.files && res.data.files.length > 0) {
    spreadsheetId = res.data.files[0].id;
  } else {
    // Create with all 4 tabs at once
    const created = await sheetsClient.spreadsheets.create({
      requestBody: {
        properties: { title: SHEET_TITLE },
        sheets: Object.keys(TAB_HEADERS).map(tab => ({
          properties: { title: tab },
          data: [{
            startRow: 0, startColumn: 0,
            rowData: [{ values: TAB_HEADERS[tab].map(v => ({ userEnteredValue: { stringValue: v } })) }]
          }]
        }))
      }
    });
    spreadsheetId = created.data.spreadsheetId;
    return spreadsheetId;
  }

  // Spreadsheet already exists — ensure all tabs exist
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const existingTabs = (meta.data.sheets || []).map(s => s.properties.title);

  const addRequests = [];
  for (const tab of Object.keys(TAB_HEADERS)) {
    if (!existingTabs.includes(tab)) {
      addRequests.push({ addSheet: { properties: { title: tab } } });
    }
  }
  if (addRequests.length > 0) {
    await sheetsClient.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: addRequests } });
  }

  // Ensure header rows for any newly created tabs
  for (const tab of Object.keys(TAB_HEADERS)) {
    if (!existingTabs.includes(tab)) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [TAB_HEADERS[tab]] }
      });
    }
  }

  return spreadsheetId;
}

/**
 * Upsert a single row in a tab.
 * @param {object} sheetsClient
 * @param {string} spreadsheetId
 * @param {string} tab         — tab name (Loads / Carriers / Drivers / Brokers)
 * @param {string} keyValue    — the unique key for this row (load ref, contact name, etc.)
 * @param {Array}  rowValues   — full row array to write
 */
async function upsertRow(sheetsClient, spreadsheetId, tab, keyValue, rowValues) {
  const range = `${tab}!A:A`;
  const existing = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
  const rows = existing.data.values || [];

  // Row 0 = header; search from row 1
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === String(keyValue));

  if (rowIndex > 0) {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowValues] }
    });
  } else {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A:A`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [rowValues] }
    });
  }
}

/**
 * Append or update a load row in the Loads tab.
 * loadData fields: ref, status, origin, destination, broker, broker_email, broker_phone,
 *   equipment, miles, rate, dispatch_fee, pickup_date, delivery_date,
 *   carrier_name, driver_name, driver_email, driver_phone, notes
 * documentLinks: array of { filename, webViewLink } — fetched from DB in server.js
 */
async function appendToSheet(userId, loadData, documentLinks) {
  try {
    const status = await userStatus(userId);
    if (!status.connected) return null;

    const auth = await clientForUser(userId);
    const sheetsClient = google.sheets({ version: 'v4', auth });
    const driveClient  = google.drive({ version: 'v3', auth });
    const spreadsheetId = await getOrCreateSpreadsheet(sheetsClient, driveClient);

    // Build document link string: "filename (url), filename2 (url2)"
    const docLinksStr = (documentLinks || [])
      .filter(d => d.webViewLink)
      .map(d => `${d.filename} (${d.webViewLink})`)
      .join('\n') || '';

    const row = [
      loadData.ref            || '',
      loadData.status         || '',
      loadData.origin         || '',
      loadData.destination    || '',
      loadData.broker         || '',
      loadData.broker_email   || '',
      loadData.broker_phone   || '',
      loadData.equipment      || '',
      loadData.miles          || 0,
      loadData.rate           || 0,
      loadData.dispatch_fee   || 0,
      loadData.pickup_date    || '',
      loadData.delivery_date  || '',
      loadData.carrier_name   || '',
      loadData.driver_name    || '',
      loadData.driver_email   || '',
      loadData.driver_phone   || '',
      loadData.notes          || '',
      docLinksStr,
      new Date().toISOString().slice(0, 19).replace('T', ' ')
    ];

    await upsertRow(sheetsClient, spreadsheetId, 'Loads', loadData.ref, row);
    return { spreadsheetId };
  } catch (err) {
    console.error(`[Google Sheets] Loads tab failed for user ${userId}:`, err.message);
    return null;
  }
}

/**
 * Refresh the Document Links cell for a load after a new file is uploaded.
 * Called by server.js after Drive upload completes.
 */
async function refreshLoadDocLinks(userId, loadRef, documentLinks) {
  try {
    const status = await userStatus(userId);
    if (!status.connected) return null;

    const auth = await clientForUser(userId);
    const sheetsClient = google.sheets({ version: 'v4', auth });
    const driveClient  = google.drive({ version: 'v3', auth });
    const spreadsheetId = await getOrCreateSpreadsheet(sheetsClient, driveClient);

    // Find the load row
    const existing = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: 'Loads!A:A'
    });
    const rows = existing.data.values || [];
    const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === String(loadRef));
    if (rowIndex < 1) return null; // load row doesn't exist yet — appendToSheet will add it

    // Column letters are computed from the header definitions so they stay
    // correct even when columns are added/removed in TAB_HEADERS.Loads.
    const colLetter = (idx) => { // idx = 0-based index → A, B, ..., Z, AA, ...
      let n = idx + 1, s = '';
      while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
      return s;
    };
    const docCol = colLetter(TAB_HEADERS.Loads.indexOf('Document Links'));
    const updCol = colLetter(TAB_HEADERS.Loads.indexOf('Updated At'));
    const docLinksStr = (documentLinks || [])
      .filter(d => d.webViewLink)
      .map(d => `${d.filename} (${d.webViewLink})`)
      .join('\n') || '';

    const sheetRow = rowIndex + 1; // 1-based
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `Loads!${docCol}${sheetRow}:${updCol}${sheetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[docLinksStr, new Date().toISOString().slice(0, 19).replace('T', ' ')]] }
    });
    return { spreadsheetId };
  } catch (err) {
    console.error(`[Google Sheets] refreshLoadDocLinks failed for user ${userId}:`, err.message);
    return null;
  }
}

/**
 * Upsert a carrier row in the Carriers tab.
 * contact fields: name, company, manager_name, dispatch_pct, phone, email, notes
 */
async function syncCarrier(userId, contact) {
  try {
    const status = await userStatus(userId);
    if (!status.connected) return null;

    const auth = await clientForUser(userId);
    const sheetsClient = google.sheets({ version: 'v4', auth });
    const driveClient  = google.drive({ version: 'v3', auth });
    const spreadsheetId = await getOrCreateSpreadsheet(sheetsClient, driveClient);

    const row = [
      contact.name          || '',
      contact.company       || '',
      contact.manager_name  || '',
      contact.dispatch_pct  || 0,
      contact.phone         || '',
      contact.email         || '',
      contact.notes         || '',
      new Date().toISOString().slice(0, 19).replace('T', ' ')
    ];
    await upsertRow(sheetsClient, spreadsheetId, 'Carriers', contact.name, row);
    return { spreadsheetId };
  } catch (err) {
    console.error(`[Google Sheets] Carriers tab failed for user ${userId}:`, err.message);
    return null;
  }
}

/**
 * Upsert a driver row in the Drivers tab.
 * contact fields: name, carrier_name (resolved), cdl_type, has_hazmat, has_twic, has_tsa,
 *   truck_unit, truck_type, truck_length, truck_weight, phone, driver_notes, notes
 */
async function syncDriver(userId, contact) {
  try {
    const status = await userStatus(userId);
    if (!status.connected) return null;

    const auth = await clientForUser(userId);
    const sheetsClient = google.sheets({ version: 'v4', auth });
    const driveClient  = google.drive({ version: 'v3', auth });
    const spreadsheetId = await getOrCreateSpreadsheet(sheetsClient, driveClient);

    const endorsements = [
      contact.has_hazmat && 'HAZMAT',
      contact.has_twic   && 'TWIC',
      contact.has_tsa    && 'TSA'
    ].filter(Boolean).join(', ');

    const row = [
      contact.name          || '',
      contact.carrier_name  || '',   // resolved by server.js before calling
      contact.cdl_type      || '',
      endorsements,
      contact.truck_unit    || '',
      contact.truck_type    || '',
      contact.truck_length  || '',
      contact.truck_weight  || '',
      contact.phone         || '',
      contact.driver_notes  || '',
      contact.notes         || '',
      new Date().toISOString().slice(0, 19).replace('T', ' ')
    ];
    await upsertRow(sheetsClient, spreadsheetId, 'Drivers', contact.name, row);
    return { spreadsheetId };
  } catch (err) {
    console.error(`[Google Sheets] Drivers tab failed for user ${userId}:`, err.message);
    return null;
  }
}

/**
 * Upsert a broker row in the Brokers tab.
 * contact fields: name, company, phone, email, notes
 */
async function syncBroker(userId, contact) {
  try {
    const status = await userStatus(userId);
    if (!status.connected) return null;

    const auth = await clientForUser(userId);
    const sheetsClient = google.sheets({ version: 'v4', auth });
    const driveClient  = google.drive({ version: 'v3', auth });
    const spreadsheetId = await getOrCreateSpreadsheet(sheetsClient, driveClient);

    const row = [
      contact.name    || '',
      contact.company || '',
      contact.phone   || '',
      contact.email   || '',
      contact.notes   || '',
      new Date().toISOString().slice(0, 19).replace('T', ' ')
    ];
    await upsertRow(sheetsClient, spreadsheetId, 'Brokers', contact.name, row);
    return { spreadsheetId };
  } catch (err) {
    console.error(`[Google Sheets] Brokers tab failed for user ${userId}:`, err.message);
    return null;
  }
}

// ─── Inbox Monitor (admin reads company mail via connected users' tokens) ────
// NOTE: reading a user's mail requires their token to include gmail.readonly —
// accounts connected before v2.4 must disconnect and reconnect once.

function headerValue(headers, name) {
  const h = (headers || []).find(x => (x.name || '').toLowerCase() === name.toLowerCase());
  return h ? (h.value || '') : '';
}

// Recursively find the best text/html body from a Gmail message payload
function extractBody(payload) {
  if (!payload) return { text: '', html: '' };
  if (payload.body && payload.body.data && !payload.body.attachmentId) {
    const raw = Buffer.from(payload.body.data, 'base64url').toString('utf8');
    const type = payload.mimeType || '';
    if (type === 'text/plain') return { text: raw, html: '' };
    if (type === 'text/html') return { text: '', html: raw };
  }
  let text = '', html = '';
  for (const part of (payload.parts || [])) {
    const r = extractBody(part);
    if (r.text && !text) text = r.text;
    if (r.html && !html) html = r.html;
  }
  return { text, html };
}

// Normalize a Gmail API message (list view or full) into our UI shape
function parseMessage(msg) {
  const payload = msg.payload || {};
  const headers = payload.headers || [];
  const { text, html } = extractBody(payload);
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: headerValue(headers, 'From'),
    to: headerValue(headers, 'To'),
    subject: headerValue(headers, 'Subject') || '(no subject)',
    date: headerValue(headers, 'Date'),
    snippet: msg.snippet || '',
    bodyText: text,
    bodyHtml: html
  };
}

// List messages in a user's mailbox. Throws if the token lacks gmail.readonly.
async function gmailSearchMessages(userId, query, maxResults) {
  const auth = await clientForUser(userId);
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query || '',
    maxResults: Math.min(Number(maxResults) || 25, 100)
  });
  const ids = (res.data.messages || []).map(m => m.id);
  const out = [];
  for (const id of ids.slice(0, 25)) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] });
    out.push(parseMessage(msg.data));
  }
  return out;
}

// Read one full message (with body). Throws if token lacks gmail.readonly.
async function gmailReadMessage(userId, messageId) {
  const auth = await clientForUser(userId);
  const gmail = google.gmail({ version: 'v1', auth });
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  return parseMessage(msg.data);
}

// Send an email AS the connected user (gmail.send scope). Optional threadId
// keeps replies threaded in Gmail. Returns the message record.
async function gmailSend(userId, { to, subject, html, threadId }) {
  const auth = await clientForUser(userId);
  const gmail = google.gmail({ version: 'v1', auth });
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="utf-8"'
  ];
  if (threadId) headers.push(`In-Reply-To: ${threadId}`, `References: ${threadId}`);
  const raw = Buffer.from(headers.join('\n') + '\n\n' + html).toString('base64url');
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: threadId || undefined }
  });
  return res.data;
}

module.exports = {
  isConfigured,
  getAuthUrl,
  handleCallback,
  userStatus,
  disconnectUser,
  clientForUser,
  // Drive
  uploadToDrive,
  // Sheets
  appendToSheet,
  refreshLoadDocLinks,
  syncCarrier,
  syncDriver,
  syncBroker,
  // Mail (admin Inbox Monitor)
  gmailSearchMessages,
  gmailReadMessage,
  gmailSend,
  parseMessage
};
