// server.js — DAT One (rebranded) MULTI-TENANT BACKEND
require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');   // built-in — for session tokens
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { initDb, getDb, seedSampleData } = require('./db');
const google = require('./services/google');
const dat = require('./services/dat');
const ai = require('./services/ai');
const mail = require('./services/mail');
const negotiator = require('./services/negotiator');
const voice = require('./services/voice');
const outreach = require('./services/outreach');
const aiChat = require('./services/ai-chat');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieSession({
  name: 'dat_one_sess',
  keys: [process.env.SESSION_SECRET || 'dat-one-secret-99'],
  maxAge: 7 * 24 * 60 * 60 * 1000
}));

const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---------- Helpers ----------
const num = v => (v === undefined || v === null || v === '' ? 0 : Number(v) || 0);
const nul = v => (v === undefined || v === '' ? null : v);

async function currentUser(req) {
  if (!req.session || !req.session.uid) return null;
  return await getDb().get('SELECT * FROM users WHERE id = ?', req.session.uid);
}

// ── requireAuth: checks session cookie AND session_token matches DB ──────────
async function requireAuth(req, res, next) {
  if (!req.session || !req.session.uid) return res.status(401).json({ error: 'Auth needed' });
  const u = await getDb().get('SELECT * FROM users WHERE id = ?', req.session.uid);
  if (!u) { req.session = null; return res.status(401).json({ error: 'Auth needed' }); }

  // Single-session enforcement: if another login replaced the token, kick this session
  if (u.session_token && req.session.sessionToken !== u.session_token) {
    req.session = null;
    return res.status(401).json({ error: 'Session replaced — please sign in again' });
  }

  req.user = u;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

async function ownedContactId(userId, contactId) {
  if (contactId === null || contactId === undefined || contactId === '') return null;
  const row = await getDb().get('SELECT id FROM contacts WHERE id = ? AND owner_id = ?', [contactId, userId]);
  return row ? row.id : null;
}
async function ownedLoad(userId, loadId) {
  return await getDb().get('SELECT * FROM loads WHERE id = ? AND owner_id = ?', [loadId, userId]);
}
async function getLoadDocLinks(loadId) {
  const docs = await getDb().all(
    'SELECT filename, drive_file_id FROM documents WHERE load_id = ? ORDER BY id ASC', loadId
  );
  return docs
    .filter(d => d.drive_file_id)
    .map(d => ({ filename: d.filename, webViewLink: `https://drive.google.com/file/d/${d.drive_file_id}/view` }));
}

// ---------- Auth ----------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const u = await getDb().get('SELECT * FROM users WHERE username = ?', (username || '').trim());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // ── Single-session enforcement ──────────────────────────────────────────────
  // New token on every login — overwrites old one, instantly kicking prior session
  const sessionToken = crypto.randomBytes(32).toString('hex');
  await getDb().run('UPDATE users SET session_token = ? WHERE id = ?', [sessionToken, u.id]);
  req.session.uid          = u.id;
  req.session.sessionToken = sessionToken;
  // ────────────────────────────────────────────────────────────────────────────

  res.json({
    ok: true,
    user: { id: u.id, username: u.username, role: u.role, full_name: u.full_name, must_change_password: u.must_change_password }
  });
});

app.post('/api/logout', async (req, res) => {
  if (req.session && req.session.uid) {
    try {
      // Clear token so this cookie can never be replayed
      await getDb().run('UPDATE users SET session_token = NULL WHERE id = ?', req.session.uid);
    } catch (e) { /* non-fatal */ }
  }
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ user: { id: u.id, username: u.username, role: u.role, full_name: u.full_name, email: u.email, phone: u.phone, must_change_password: u.must_change_password } });
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  if (!req.user.must_change_password) {
    if (!bcrypt.compareSync(current_password || '', req.user.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
  }
  await getDb().run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [bcrypt.hashSync(new_password, 10), req.user.id]);
  res.json({ ok: true });
});

// ── Forgot password: request a reset link ───────────────────────────────────
// Security: the response is identical whether or not the identifier matches an
// account, and no email is sent for unknown identifiers (no account enumeration).
app.post('/api/forgot-password', async (req, res) => {
  const identifier = String(req.body.identifier || '').trim();
  if (identifier) {
    try {
      const u = await getDb().get(
        `SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND email <> '' AND lower(email) = lower(?))`,
        [identifier, identifier]
      );
      if (u && u.email) {
        const token = crypto.randomBytes(32).toString('hex');
        const expires = Date.now() + 60 * 60 * 1000; // 1 hour
        await getDb().run('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?', [token, String(expires), u.id]);
        const base = mail.appUrl() || 'https://dat-one.onrender.com';
        const r = await mail.sendReset({ to: u.email, username: u.username, resetUrl: `${base}/?reset=${token}` });
        if (r.status === 'skipped' || r.status === 'failed') {
          console.warn(`[Auth] Forgot-password: mail ${r.status} (${r.reason}) for user ${u.username}`);
        }
      }
    } catch (e) {
      console.error('[Auth] forgot-password error:', e.message);
    }
  }
  res.json({ ok: true });
});

// ── Forgot username: email or phone → email the username ────────────────────
// Same no-enumeration pattern as forgot-password.
app.post('/api/forgot-username', async (req, res) => {
  const identifier = String(req.body.identifier || '').trim();
  if (identifier) {
    try {
      const u = await getDb().get(
        `SELECT * FROM users
          WHERE (email IS NOT NULL AND email <> '' AND lower(email) = lower(?))
             OR (phone IS NOT NULL AND phone <> '' AND phone = ?)`,
        [identifier, identifier]
      );
      if (u && u.email) {
        const r = await mail.sendUsername({ to: u.email, username: u.username });
        if (r.status === 'skipped' || r.status === 'failed') {
          console.warn(`[Auth] Forgot-username: mail ${r.status} (${r.reason}) for user ${u.username}`);
        }
      }
    } catch (e) {
      console.error('[Auth] forgot-username error:', e.message);
    }
  }
  res.json({ ok: true });
});

// Validate a reset token without revealing account details
app.get('/api/reset/info', async (req, res) => {
  const token = String(req.query.token || '');
  const u = token
    ? await getDb().get('SELECT username, reset_expires FROM users WHERE reset_token = ?', token)
    : null;
  const valid = !!u && u.reset_expires && Number(u.reset_expires) > Date.now();
  res.json({ valid, username: valid ? u.username : null });
});

// Set a new password using a valid reset token (single-use, expires in 1h)
app.post('/api/reset-password', async (req, res) => {
  const { token, new_password } = req.body || {};
  if (!token || typeof new_password !== 'string' || new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const u = await getDb().get('SELECT * FROM users WHERE reset_token = ?', String(token));
  if (!u || !u.reset_expires || Number(u.reset_expires) < Date.now()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  }
  // Update password, consume the token, and invalidate all sessions for this user
  await getDb().run(
    `UPDATE users SET password_hash = ?, must_change_password = 0,
       reset_token = NULL, reset_expires = NULL, session_token = NULL WHERE id = ?`,
    [bcrypt.hashSync(new_password, 10), u.id]
  );
  res.json({ ok: true });
});

app.put('/api/profile', requireAuth, async (req, res) => {
  const { full_name, email, phone } = req.body;
  await getDb().run('UPDATE users SET full_name = ?, email = ?, phone = ? WHERE id = ?', [nul(full_name), nul(email), nul(phone), req.user.id]);
  res.json({ ok: true });
});

// ---------- Users (admin) ----------
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  res.json(await getDb().all('SELECT id, username, full_name, email, phone, role, must_change_password, created_at FROM users ORDER BY id ASC'));
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, full_name, email, phone, role, seed_sample } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  try {
    const info = await getDb().run(
      `INSERT INTO users (username, password_hash, full_name, email, phone, role, must_change_password) VALUES (?,?,?,?,?,?,1)`,
      [username.trim(), bcrypt.hashSync(password, 10), nul(full_name), nul(email), nul(phone), role || 'dispatcher']
    );
    if (seed_sample) await seedSampleData(info.lastID);
    // Invite email: SMTP → admin's (or any) connected Gmail → skipped. Never blocks creation.
    let emailRes = { status: 'skipped', reason: 'no_email' };
    if (email) {
      try {
        emailRes = await mail.sendInvite({ to: email, username: username.trim(), password, adminUserId: req.user.id });
      } catch (e) {
        emailRes = { status: 'failed', reason: e.message };
        console.error('[Mail] invite send error:', e.message);
      }
    }
    console.log(`[Users] created "${username.trim()}" (id ${info.lastID}) — invite email: ${emailRes.status} (${emailRes.reason})`);
    res.json({ ok: true, id: info.lastID, email: emailRes.status, email_reason: emailRes.reason });
  } catch (e) { res.status(400).json({ error: 'That username already exists' }); }
});

app.post('/api/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  // Also clear session_token so the user is forced to log back in
  await getDb().run(
    'UPDATE users SET password_hash = ?, must_change_password = 1, session_token = NULL WHERE id = ?',
    [bcrypt.hashSync(password, 10), req.params.id]
  );
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  await getDb().run('DELETE FROM users WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// ---------- Contacts (per-user) ----------
app.get('/api/contacts', requireAuth, async (req, res) => {
  const { type } = req.query;
  if (type) return res.json(await getDb().all('SELECT * FROM contacts WHERE owner_id = ? AND type = ? ORDER BY name ASC', [req.user.id, type]));
  res.json(await getDb().all('SELECT * FROM contacts WHERE owner_id = ? ORDER BY name ASC', req.user.id));
});

app.post('/api/contacts', requireAuth, async (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'Name is required' });
  const parent = await ownedContactId(req.user.id, b.parent_carrier_id);
  const info = await getDb().run(
    `INSERT INTO contacts (owner_id, name, company, email, phone, type, manager_name, dispatch_pct, parent_carrier_id, has_hazmat, has_twic, has_tsa, cdl_type, truck_unit, truck_type, truck_length, truck_weight, driver_notes, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.user.id, b.name, nul(b.company), nul(b.email), nul(b.phone), b.type || 'broker', nul(b.manager_name), num(b.dispatch_pct),
     parent, num(b.has_hazmat), num(b.has_twic), num(b.has_tsa), nul(b.cdl_type), nul(b.truck_unit),
     nul(b.truck_type), num(b.truck_length), num(b.truck_weight), nul(b.driver_notes), nul(b.notes)]
  );

  const contactType = b.type || 'broker';
  if (contactType === 'carrier') {
    google.syncCarrier(req.user.id, b).catch(e => console.error('[Sheets] POST carrier:', e.message));
  } else if (contactType === 'driver') {
    const carrierRow = parent ? await getDb().get('SELECT name FROM contacts WHERE id = ?', parent) : null;
    google.syncDriver(req.user.id, { ...b, carrier_name: carrierRow ? carrierRow.name : '' })
      .catch(e => console.error('[Sheets] POST driver:', e.message));
  } else if (contactType === 'broker') {
    google.syncBroker(req.user.id, b).catch(e => console.error('[Sheets] POST broker:', e.message));
  }

  res.json({ ok: true, id: info.lastID });
});

app.put('/api/contacts/:id', requireAuth, async (req, res) => {
  const b = req.body;
  const own = await getDb().get('SELECT id FROM contacts WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
  if (!own) return res.status(404).json({ error: 'Not found' });
  const parent = await ownedContactId(req.user.id, b.parent_carrier_id);
  await getDb().run(
    `UPDATE contacts SET name=?, company=?, email=?, phone=?, type=?, manager_name=?, dispatch_pct=?, parent_carrier_id=?, has_hazmat=?, has_twic=?, has_tsa=?, cdl_type=?, truck_unit=?, truck_type=?, truck_length=?, truck_weight=?, driver_notes=?, notes=? WHERE id=? AND owner_id=?`,
    [b.name, nul(b.company), nul(b.email), nul(b.phone), b.type, nul(b.manager_name), num(b.dispatch_pct),
     parent, num(b.has_hazmat), num(b.has_twic), num(b.has_tsa), nul(b.cdl_type), nul(b.truck_unit),
     nul(b.truck_type), num(b.truck_length), num(b.truck_weight), nul(b.driver_notes), nul(b.notes),
     req.params.id, req.user.id]
  );

  if (b.type === 'carrier') {
    google.syncCarrier(req.user.id, b).catch(e => console.error('[Sheets] PUT carrier:', e.message));
  } else if (b.type === 'driver') {
    const carrierRow = parent ? await getDb().get('SELECT name FROM contacts WHERE id = ?', parent) : null;
    google.syncDriver(req.user.id, { ...b, carrier_name: carrierRow ? carrierRow.name : '' })
      .catch(e => console.error('[Sheets] PUT driver:', e.message));
  } else if (b.type === 'broker') {
    google.syncBroker(req.user.id, b).catch(e => console.error('[Sheets] PUT broker:', e.message));
  }

  res.json({ ok: true });
});

app.delete('/api/contacts/:id', requireAuth, async (req, res) => {
  await getDb().run('DELETE FROM contacts WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ---------- Loads (per-user) ----------
app.get('/api/loads', requireAuth, async (req, res) => {
  const loads = await getDb().all(`
    SELECT l.*, c.name AS carrier_name, c.company AS carrier_company, d.name AS driver_name
    FROM loads l
    LEFT JOIN contacts c ON c.id = l.carrier_id
    LEFT JOIN contacts d ON d.id = l.driver_id
    WHERE l.owner_id = ?
    ORDER BY l.updated_at DESC, l.id DESC
  `, req.user.id);
  res.json(loads);
});

// Resolve broker contact by typed name/company (used by POST/PUT loads so
// broker email/phone stay in sync with the Brokers tab even when the frontend
// sends only the name).
async function findBrokerContact(userId, brokerName) {
  if (!brokerName) return null;
  return await getDb().get(
    "SELECT * FROM contacts WHERE owner_id = ? AND type = 'broker' AND (name = ? OR company = ?) LIMIT 1",
    [userId, brokerName, brokerName]
  );
}

app.post('/api/loads', requireAuth, async (req, res) => {
  const b = req.body;
  try {
    const carrier = await ownedContactId(req.user.id, b.carrier_id);
    const driver  = await ownedContactId(req.user.id, b.driver_id);
    const carrierRow = carrier ? await getDb().get('SELECT * FROM contacts WHERE id = ?', carrier) : null;
    const driverRow  = driver  ? await getDb().get('SELECT * FROM contacts WHERE id = ?', driver)  : null;
    const brokerRow  = await findBrokerContact(req.user.id, b.broker);
    // Contact details win unless the form explicitly overrides them
    const brokerEmail = nul(b.broker_email) || (brokerRow ? brokerRow.email : null);
    const brokerPhone = nul(b.broker_phone) || (brokerRow ? brokerRow.phone : null);
    const driverEmail = nul(b.driver_email) || (driverRow ? driverRow.email : null);
    const driverPhone = nul(b.driver_phone) || (driverRow ? driverRow.phone : null);
    const info = await getDb().run(
      `INSERT INTO loads (owner_id, ref, status, broker, broker_email, broker_phone, origin, destination, pickup_date, delivery_date, equipment, miles, rate, dispatch_fee, carrier_id, driver_id, driver_email, driver_phone, notes, assigned_user)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.user.id, b.ref || 'L-' + Date.now(), b.status || 'booked', nul(b.broker), brokerEmail, brokerPhone,
       nul(b.origin), nul(b.destination), nul(b.pickup_date), nul(b.delivery_date), nul(b.equipment),
       num(b.miles), num(b.rate), num(b.dispatch_fee), carrier, driver, driverEmail, driverPhone, nul(b.notes), req.user.id]
    );
    google.appendToSheet(req.user.id, {
      ...b,
      miles: num(b.miles), rate: num(b.rate), dispatch_fee: num(b.dispatch_fee),
      broker_email: brokerEmail || '', broker_phone: brokerPhone || '',
      driver_email: driverEmail || '', driver_phone: driverPhone || '',
      carrier_name: carrierRow ? carrierRow.name : '',
      driver_name:  driverRow  ? driverRow.name  : ''
    }, []).catch(e => console.error('[Sheets] POST /api/loads:', e.message));
    res.json({ ok: true, id: info.lastID });
  } catch (e) { res.status(400).json({ error: 'That load reference already exists' }); }
});

app.put('/api/loads/:id', requireAuth, async (req, res) => {
  const b = req.body;
  const own = await ownedLoad(req.user.id, req.params.id);
  if (!own) return res.status(404).json({ error: 'Not found' });
  const carrier = await ownedContactId(req.user.id, b.carrier_id);
  const driver  = await ownedContactId(req.user.id, b.driver_id);
  const carrierRow = carrier ? await getDb().get('SELECT * FROM contacts WHERE id = ?', carrier) : null;
  const driverRow  = driver  ? await getDb().get('SELECT * FROM contacts WHERE id = ?', driver)  : null;
  const brokerRow  = await findBrokerContact(req.user.id, b.broker);
  const brokerEmail = nul(b.broker_email) || (brokerRow ? brokerRow.email : null);
  const brokerPhone = nul(b.broker_phone) || (brokerRow ? brokerRow.phone : null);
  const driverEmail = nul(b.driver_email) || (driverRow ? driverRow.email : null);
  const driverPhone = nul(b.driver_phone) || (driverRow ? driverRow.phone : null);
  await getDb().run(
    `UPDATE loads SET ref=?, status=?, broker=?, broker_email=?, broker_phone=?, origin=?, destination=?, pickup_date=?, delivery_date=?, equipment=?, miles=?, rate=?, dispatch_fee=?, carrier_id=?, driver_id=?, driver_email=?, driver_phone=?, notes=?, updated_at=datetime('now') WHERE id=? AND owner_id=?`,
    [b.ref, b.status, nul(b.broker), brokerEmail, brokerPhone, nul(b.origin), nul(b.destination),
     nul(b.pickup_date), nul(b.delivery_date), nul(b.equipment), num(b.miles), num(b.rate), num(b.dispatch_fee),
     carrier, driver, driverEmail, driverPhone, nul(b.notes), req.params.id, req.user.id]
  );
  const docLinks   = await getLoadDocLinks(req.params.id);
  google.appendToSheet(req.user.id, {
    ...b,
    miles: num(b.miles), rate: num(b.rate), dispatch_fee: num(b.dispatch_fee),
    broker_email: brokerEmail || '', broker_phone: brokerPhone || '',
    driver_email: driverEmail || '', driver_phone: driverPhone || '',
    carrier_name: carrierRow ? carrierRow.name : '',
    driver_name:  driverRow  ? driverRow.name  : ''
  }, docLinks).catch(e => console.error('[Sheets] PUT /api/loads:', e.message));
  res.json({ ok: true });
});

app.delete('/api/loads/:id', requireAuth, async (req, res) => {
  await getDb().run('DELETE FROM loads WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ---------- Documents ----------
app.get('/api/loads/:id/documents', requireAuth, async (req, res) => {
  const own = await ownedLoad(req.user.id, req.params.id);
  if (!own) return res.status(404).json({ error: 'Not found' });
  res.json(await getDb().all(
    'SELECT id, load_id, filename, mime, size, drive_file_id, created_at FROM documents WHERE load_id = ? ORDER BY id DESC',
    req.params.id
  ));
});

app.post('/api/loads/:id/documents', requireAuth, upload.single('file'), async (req, res) => {
  const own = await ownedLoad(req.user.id, req.params.id);
  if (!own) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const info = await getDb().run(
    'INSERT INTO documents (load_id, filename, mime, size, data) VALUES (?,?,?,?,?)',
    [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer]
  );
  const docId = info.lastID;
  res.json({ ok: true, id: docId });
  const driveFilename = `${own.ref}_${req.file.originalname}`;
  google.uploadToDrive(req.user.id, driveFilename, req.file.buffer, req.file.mimetype)
    .then(async (result) => {
      if (!result || !result.fileId) return;
      await getDb().run('UPDATE documents SET drive_file_id = ? WHERE id = ?', [result.fileId, docId]);
      const allDocLinks = await getLoadDocLinks(req.params.id);
      await google.refreshLoadDocLinks(req.user.id, own.ref, allDocLinks)
        .catch(e => console.error('[Sheets] refreshLoadDocLinks:', e.message));
    })
    .catch(e => console.error('[Drive] POST /api/loads/:id/documents:', e.message));
});

app.get('/api/documents/:id', requireAuth, async (req, res) => {
  const doc = await getDb().get(`
    SELECT d.* FROM documents d
    JOIN loads l ON l.id = d.load_id
    WHERE d.id = ? AND l.owner_id = ?
  `, [req.params.id, req.user.id]);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
  res.send(doc.data);
});

app.delete('/api/documents/:id', requireAuth, async (req, res) => {
  const doc = await getDb().get(`
    SELECT d.id FROM documents d
    JOIN loads l ON l.id = d.load_id
    WHERE d.id = ? AND l.owner_id = ?
  `, [req.params.id, req.user.id]);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  await getDb().run('DELETE FROM documents WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// ---------- Performance / Dashboard ----------
// Query params:
//   period      = daily | weekly (default) | monthly | quarterly | all
//   carrier_id  = optional contact id (type=carrier, owned by this user) to scope
//                 the dashboard to one carrier instead of all carriers.
function perfBucketKey(d, period) {
  const pad = n => String(n).padStart(2, '0');
  switch (period) {
    case 'daily':     return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    case 'monthly':
    case 'all':       return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; // All Time still trends by month
    case 'quarterly': return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
    case 'weekly':
    default: {
      const onejan = new Date(d.getFullYear(), 0, 1);
      const weekNum = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
      return `${d.getFullYear()}-W${pad(weekNum)}`;
    }
  }
}

app.get('/api/performance', requireAuth, async (req, res) => {
  const period = ['daily', 'weekly', 'monthly', 'quarterly', 'all'].includes(req.query.period)
    ? req.query.period : 'weekly';
  const carrierId = req.query.carrier_id ? Number(req.query.carrier_id) : null;

  let sql = "SELECT * FROM loads WHERE owner_id = ? AND status != 'cancelled'";
  const params = [req.user.id];
  if (carrierId) {
    // Ownership check — a user can only scope to their own carrier contact
    const owned = await getDb().get(
      'SELECT id FROM contacts WHERE id = ? AND owner_id = ? AND type = ?',
      [carrierId, req.user.id, 'carrier']
    );
    if (!owned) return res.status(400).json({ error: 'Unknown carrier' });
    sql += ' AND carrier_id = ?';
    params.push(carrierId);
  }
  const loads = await getDb().all(sql, params);

  const buckets = {};
  const statusCounts = {};
  loads.forEach(l => {
    const d = new Date(l.pickup_date || l.created_at);
    if (isNaN(d.getTime())) return;
    const k = perfBucketKey(d, period);
    if (!buckets[k]) buckets[k] = { label: k, revenue: 0, fees: 0, miles: 0, count: 0 };
    buckets[k].revenue += l.rate || 0;
    buckets[k].fees += l.dispatch_fee || 0;
    buckets[k].miles += l.miles || 0;
    buckets[k].count += 1;
    statusCounts[l.status] = (statusCounts[l.status] || 0) + 1;
  });
  const series = Object.values(buckets).sort((a, b) => a.label.localeCompare(b.label));
  const totals = series.reduce((a, c) => ({
    revenue: a.revenue + c.revenue, fees: a.fees + c.fees, miles: a.miles + c.miles, count: a.count + c.count
  }), { revenue: 0, fees: 0, miles: 0, count: 0 });
  totals.rpm = totals.miles > 0 ? totals.revenue / totals.miles : 0;
  res.json({ series, totals, statusCounts, period, carrier_id: carrierId || null });
});

// ---------- Integrations ----------
app.get('/api/settings/integrations', requireAuth, async (req, res) => {
  const gStatus = await google.userStatus(req.user.id);
  res.json({
    google: { configured: google.isConfigured(), connected: gStatus.connected, email: gStatus.email || null },
    dat: dat.isConfigured(),
    ai: ai.isConfigured()
  });
});

app.get('/api/dat/search', requireAuth, async (req, res) => {
  try {
    const loads = await dat.search(req.query || {});
    res.json({ loads, live: dat.isConfigured() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- AI Fleet Assistant (chat + preferences) ----------
app.post('/api/ai/chat', requireAuth, async (req, res) => {
  try {
    const r = await aiChat.chat(req.user.id, String(req.body.message || '').trim());
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ai/chat', requireAuth, async (req, res) => {
  res.json({
    history: await aiChat.history(req.user.id),
    prefs: await aiChat.getPrefs(req.user.id)
  });
});

app.post('/api/ai/prefs/remove', requireAuth, async (req, res) => {
  res.json({ ok: true, prefs: await aiChat.removePref(req.user.id, String(req.body.key || '')) });
});

// Generic "send this email" for the Templates page — from the owner's Gmail.
app.post('/api/mail/send', requireAuth, async (req, res) => {
  const { to, subject, body } = req.body || {};
  if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject and body are required' });
  try {
    const status = await google.userStatus(req.user.id);
    if (!status.connected) {
      return res.status(400).json({ error: 'Connect Google in Settings first — the AI sends as you.' });
    }
    const sent = await google.gmailSend(req.user.id, {
      to, subject,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;">${String(body).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div>`
    });
    res.json({ ok: true, id: sent.id, threadId: sent.threadId });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- DAT listing outreach (AI emails to brokers) ----------
// The frontend sends the full normalized DAT load object from the board; the
// service composes + sends the AI email from the OWNER's connected Gmail and
// logs it to dat_outreach. Never blocks on Google failures.
app.post('/api/dat/outreach', requireAuth, async (req, res) => {
  const load = req.body && req.body.load ? req.body.load : (req.body || {});
  const result = await outreach.emailBrokerFromLoad({
    ownerId: req.user.id, load,
    subject: req.body.subject, body: req.body.body
  });
  if (!result.ok) {
    return res.status(result.status === 'failed' && ['no_email', 'no_google', 'invalid_email'].includes(result.reason) ? 400 : 502)
      .json({ ok: false, status: result.status, reason: result.reason, message: result.message });
  }
  res.json(result);
});

app.get('/api/dat/outreach', requireAuth, async (req, res) => {
  res.json({ rows: await outreach.listOutreach(req.user.id) });
});

app.post('/api/dat/outreach/poll', requireAuth, async (req, res) => {
  try {
    const r = await outreach.pollReplies(req.user.id);
    res.json({ ok: true, found: r.found });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/draft', requireAuth, async (req, res) => {
  try {
    const draft = await ai.draft(req.body || {});
    res.json({ draft, ai: ai.isConfigured() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Inbox Monitor (ADMIN ONLY) ----------
// Lets the admin read/search emails of any Google account connected through the
// app (official company mailboxes). Server-side enforcement — dispatchers get 403.
app.get('/api/mail/accounts', requireAuth, requireAdmin, async (req, res) => {
  const rows = await getDb().all(
    `SELECT ui.user_id, ui.extra, ui.updated_at, u.username, u.role
     FROM user_integrations ui JOIN users u ON u.id = ui.user_id
     WHERE ui.provider = 'google' AND ui.refresh_token IS NOT NULL
     ORDER BY ui.updated_at DESC`
  );
  const accounts = rows.map(r => {
    let googleEmail = null;
    try { googleEmail = r.extra ? JSON.parse(r.extra).email || null : null; } catch (_) {}
    return { user_id: r.user_id, google_email: googleEmail, updated_at: r.updated_at, username: r.username, role: r.role };
  });
  res.json({ accounts });
});

app.get('/api/mail/search', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.query.user_id);
  const q = String(req.query.q || '').slice(0, 200);
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  try {
    const messages = await google.gmailSearchMessages(userId, q, req.query.max);
    res.json({ messages });
  } catch (e) {
    const needReconnect = /consent|scope|unauthorized|invalid_grant|not been granted/i.test(e.message);
    res.status(400).json({ error: needReconnect ? 'That user needs to reconnect Google to grant email read access' : e.message });
  }
});

app.get('/api/mail/read', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.query.user_id);
  const id = String(req.query.id || '');
  if (!userId || !id) return res.status(400).json({ error: 'user_id and id are required' });
  try {
    const message = await google.gmailReadMessage(userId, id);
    res.json({ message });
  } catch (e) {
    const needReconnect = /consent|scope|unauthorized|invalid_grant|not been granted/i.test(e.message);
    res.status(400).json({ error: needReconnect ? 'That user needs to reconnect Google to grant email read access' : e.message });
  }
});

// ---------- AI Negotiation (email bots) ----------
app.post('/api/negotiation/campaigns', requireAuth, async (req, res) => {
  try {
    const id = await negotiator.createCampaign(req.user.id, req.body, req.body.broker_ids);
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/negotiation/campaigns', requireAuth, async (req, res) => {
  const campaigns = await getDb().all(
    `SELECT c.*,
       (SELECT COUNT(*) FROM negotiation_threads t WHERE t.campaign_id = c.id) AS threads,
       (SELECT COUNT(*) FROM negotiation_threads t WHERE t.campaign_id = c.id AND t.status = 'agreed') AS agreed,
       (SELECT COUNT(*) FROM negotiation_threads t WHERE t.campaign_id = c.id AND t.status = 'needs_approval') AS pending
     FROM negotiation_campaigns c WHERE c.owner_id = ? ORDER BY c.created_at DESC`,
    [req.user.id]
  );
  res.json({ campaigns });
});

app.get('/api/negotiation/campaigns/:id', requireAuth, async (req, res) => {
  const campaign = await getDb().get(
    'SELECT * FROM negotiation_campaigns WHERE id = ? AND owner_id = ?',
    [req.params.id, req.user.id]
  );
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  const threads = await getDb().all(
    'SELECT * FROM negotiation_threads WHERE campaign_id = ? ORDER BY id ASC',
    [campaign.id]
  );
  const messages = await getDb().all(
    `SELECT m.* FROM negotiation_messages m
     JOIN negotiation_threads t ON t.id = m.thread_id
     WHERE t.campaign_id = ? ORDER BY m.id ASC`,
    [campaign.id]
  );
  res.json({ campaign, threads, messages });
});

app.post('/api/negotiation/campaigns/:id/pause', requireAuth, async (req, res) => {
  const r = await getDb().run(
    'UPDATE negotiation_campaigns SET status = ? WHERE id = ? AND owner_id = ?',
    ['paused', req.params.id, req.user.id]
  );
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.post('/api/negotiation/campaigns/:id/resume', requireAuth, async (req, res) => {
  const r = await getDb().run(
    'UPDATE negotiation_campaigns SET status = ? WHERE id = ? AND owner_id = ?',
    ['active', req.params.id, req.user.id]
  );
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  negotiator.pollCampaigns().catch(() => {});
  res.json({ ok: true });
});

app.post('/api/negotiation/threads/:id/approve', requireAuth, async (req, res) => {
  try {
    const sent = await negotiator.approvePendingDraft(req.user.id, req.params.id);
    res.json({ ok: true, sent });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Poll for broker replies every 5 minutes (started after server boots)
setInterval(() => negotiator.pollCampaigns().catch(e => console.error('[Negotiator] poll error:', e.message)), 5 * 60 * 1000);

// ---------- Voice AI (v3: Twilio + Gemini Live) ----------
// Outbound flow: user clicks 📞 Call on a DAT row → POST /api/voice/call →
// market research on the lane → Twilio dials the broker into a conference →
// media stream attached to the broker participant → Gemini Live speaks as the
// expert dispatcher. Live transcript, negotiation alerts, dispatcher takeover
// (VOICE_FORWARD_TO dialed into the room), recordings, and live listening all
// hang off the same conference.
app.post('/api/voice/call', requireAuth, async (req, res) => {
  const load = req.body && req.body.load ? req.body.load : null;
  if (!load) return res.status(400).json({ error: 'A DAT load is required — pass { load }' });
  try {
    const result = await voice.createOutboundCall({
      ownerId: req.user.id, load, context: req.body.context || ''
    });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/voice/calls', requireAuth, async (req, res) => {
  res.json({ calls: await voice.listCalls(req.user.id) });
});

// Dispatcher take-over: dial VOICE_FORWARD_TO into the call's conference room.
app.post('/api/voice/:id/join', requireAuth, async (req, res) => {
  try {
    const r = await voice.joinCall(Number(req.params.id), req.user.id);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// End an in-progress call.
app.post('/api/voice/:id/end', requireAuth, async (req, res) => {
  try {
    const r = await voice.endCall(Number(req.params.id), req.user.id);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Twilio fetches this to get the TwiML for the outbound leg (broker → conference).
// Public on purpose — Twilio calls it; it contains no private data.
app.get('/api/voice/twilio/voice', (req, res) => {
  const callId = Number(req.query.callId);
  if (!callId) return res.status(400).send('Missing callId');
  res.setHeader('Content-Type', 'text/xml');
  res.send(voice.twimlForCall(callId));
});

// Twilio status / recording / conference callbacks.
app.post('/api/voice/twilio/status', async (req, res) => {
  try {
    const callId = Number(req.query.callId);
    if (!callId) return res.status(400).json({ error: 'Missing callId' });
    await voice.logEvent('twilio-gemini', { type: 'twilio.status', callId, event: req.body.StatusCallbackEvent || '', status: req.body.CallStatus || '', recording: !!req.query.recording });
    await voice.updateFromTwilio(req.body || {}, callId, { recording: !!req.query.recording, join: !!req.query.join });
    res.type('text/xml').send('<Response/>');
  } catch (e) {
    console.error('[Voice] twilio status:', e.message);
    res.type('text/xml').send('<Response/>');
  }
});

// Poll broker replies on DAT outreach every 5 minutes (all owners with sent rows)
setInterval(async () => {
  try {
    const owners = await getDb().all(
      `SELECT DISTINCT owner_id FROM dat_outreach WHERE status = 'sent' AND broker_email IS NOT NULL AND broker_email != ''`
    );
    for (const o of owners) {
      outreach.pollReplies(o.owner_id).catch(e => console.error('[Outreach] poll error:', e.message));
    }
  } catch (e) { console.error('[Outreach] poll sweep error:', e.message); }
}, 5 * 60 * 1000);

// ---------- Google OAuth ----------
app.get('/auth/google', requireAuth, (req, res) => {
  if (!google.isConfigured()) return res.status(400).send('Google integration is not configured.');
  res.redirect(google.getAuthUrl(String(req.user.id)));
});

app.get('/auth/google/callback', requireAuth, async (req, res) => {
  try {
    const state = req.query.state || '';
    if (String(state) !== String(req.user.id)) return res.redirect('/?google=error');
    await google.handleCallback(req.query.code, req.user.id);
    res.redirect('/?google=connected');
  } catch (e) {
    console.error('Google callback error:', e.message);
    res.redirect('/?google=error');
  }
});

app.post('/api/google/disconnect', requireAuth, async (req, res) => {
  await google.disconnectUser(req.user.id);
  res.json({ ok: true });
});

// ---------- Static / SPA fallback ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- WebSockets (Twilio Media Streams + live listen) ----------
const wss = new WebSocketServer({ noServer: true });
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/voice/ws') {
    const callId = Number(searchParams.get('callId'));
    wss.handleUpgrade(req, socket, head, (ws) => {
      voice.handleStream(ws, { callId }).catch(e => { console.error('[Voice] stream:', e.message); try { ws.close(); } catch (_) {} });
    });
  } else if (pathname === '/api/voice/ws/live') {
    const callId = Number(searchParams.get('callId'));
    wss.handleUpgrade(req, socket, head, (ws) => voice.handleLiveSocket(ws, { callId }));
  } else {
    socket.destroy();
  }
});

initDb()
  .then(() => server.listen(PORT, () => console.log(`DAT One running on :${PORT}`)))
  .catch(err => { console.error('FATAL: failed to start', err); process.exit(1); });
