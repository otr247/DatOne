// db.js — MULTI-TENANT SCHEMA (per-user data isolation)
//
// PERSISTENCE (v3.3): by default the DB is a local SQLite file (data/dispatch.db).
// Render's FREE tier wipes that file on every restart — to keep sheets links,
// drivers, loads, and all data permanently, set TURSO_DATABASE_URL (+ optional
// TURSO_AUTH_TOKEN) to a free hosted Turso database (turso.tech). The libSQL
// adapter below exposes the same run/all/get/exec API, so nothing else changes.
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TURSO_URL = (process.env.TURSO_DATABASE_URL || '').trim();
const USE_TURSO = !!TURSO_URL;

let db;

async function initDb() {
  if (USE_TURSO) {
    // Hosted libSQL (Turso) — survives Render free-tier restarts.
    const { createClient } = require('@libsql/client');
    const client = createClient({
      url: TURSO_URL,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined
    });
    // The `sqlite` package accepts BOTH variadic params (get(sql, a, b)) and an
    // array (get(sql, [a, b])) — normalize to an array for libsql.
    const toArgs = (params) => {
      if (Array.isArray(params)) return params;
      if (params === undefined || params === null) return [];
      return [params];
    };
    db = {
      async run(sql, ...params) {
        const r = await client.execute({ sql, args: toArgs(params.length > 1 ? params : params[0]) });
        return { lastID: Number(r.lastInsertRowid), changes: Number(r.rowsAffected || 0) };
      },
      async all(sql, ...params) {
        const r = await client.execute({ sql, args: toArgs(params.length > 1 ? params : params[0]) });
        return r.rows;
      },
      async get(sql, ...params) {
        const r = await client.execute({ sql, args: toArgs(params.length > 1 ? params : params[0]) });
        return r.rows[0];
      },
      async exec(sql) {
        await client.executeMultiple(sql);
      }
    };
  } else {
    db = await open({ filename: path.join(DATA_DIR, 'dispatch.db'), driver: sqlite3.Database });
    await db.exec('PRAGMA foreign_keys = ON');
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      email TEXT,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'dispatcher',
      must_change_password INTEGER NOT NULL DEFAULT 1,
      session_token TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      company TEXT,
      email TEXT,
      phone TEXT,
      type TEXT DEFAULT 'broker',
      manager_name TEXT,
      dispatch_pct REAL DEFAULT 0,
      parent_carrier_id INTEGER,
      has_hazmat INTEGER DEFAULT 0,
      has_twic INTEGER DEFAULT 0,
      has_tsa INTEGER DEFAULT 0,
      cdl_type TEXT,
      truck_unit TEXT,
      truck_type TEXT,
      truck_length INTEGER,
      truck_weight INTEGER,
      driver_notes TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(parent_carrier_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS loads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      ref TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'booked',
      broker TEXT,
      broker_email TEXT,
      broker_phone TEXT,
      origin TEXT,
      destination TEXT,
      pickup_date TEXT,
      delivery_date TEXT,
      equipment TEXT,
      miles REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      dispatch_fee REAL DEFAULT 0,
      carrier_id INTEGER,
      driver_id INTEGER,
      notes TEXT,
      assigned_user INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_id, ref),
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(carrier_id) REFERENCES contacts(id),
      FOREIGN KEY(driver_id) REFERENCES contacts(id)
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      load_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT,
      size INTEGER DEFAULT 0,
      data BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(load_id) REFERENCES loads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_integrations (
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      expiry_date INTEGER,
      scope TEXT,
      token_type TEXT,
      extra TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, provider),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- AI negotiation campaigns (email bots)
    CREATE TABLE IF NOT EXISTS negotiation_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      origin TEXT,
      destination TEXT,
      equipment TEXT,
      pickup_date TEXT,
      target_rate REAL,
      min_rate REAL,
      max_rounds INTEGER NOT NULL DEFAULT 3,
      auto_send INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS negotiation_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      broker_contact_id INTEGER,
      broker_email TEXT NOT NULL,
      broker_name TEXT,
      gmail_thread_id TEXT,
      round INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'negotiating',
      last_email_id TEXT,
      last_reply_at TEXT,
      summary TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(campaign_id) REFERENCES negotiation_campaigns(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS negotiation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      direction TEXT NOT NULL,          -- 'out' (we sent) | 'in' (broker reply) | 'draft' (AI pending)
      subject TEXT,
      body TEXT,
      gmail_msg_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(thread_id) REFERENCES negotiation_threads(id) ON DELETE CASCADE
    );

    -- Voice AI agent events (provider webhooks + outbound requests)
    CREATE TABLE IF NOT EXISTS voice_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT,
      event_type TEXT,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- v2.6: AI outreach to brokers from DAT load board listings (emails)
    CREATE TABLE IF NOT EXISTS dat_outreach (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      dat_load_id TEXT,
      broker_name TEXT,
      broker_email TEXT,
      broker_phone TEXT,
      ref_number TEXT,
      lane TEXT,
      direction TEXT NOT NULL DEFAULT 'out',   -- 'out' | 'in' (broker reply)
      subject TEXT,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'sent',     -- sent | failed | replied
      gmail_thread_id TEXT,
      gmail_msg_id TEXT,
      reply_snippet TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- v2.6: structured voice call log (AI voice agent, provider = Vapi/Retell)
    CREATE TABLE IF NOT EXISTS voice_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      dat_load_id TEXT,
      broker_name TEXT,
      phone TEXT,
      provider TEXT,
      provider_call_id TEXT,
      status TEXT NOT NULL DEFAULT 'requested', -- requested | started | ended | failed
      duration_s INTEGER DEFAULT 0,
      transcript_summary TEXT,
      context TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- v3.4: AI fleet assistant — chat history + extracted preferences
    CREATE TABLE IF NOT EXISTS ai_chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ai_prefs (
      owner_id INTEGER PRIMARY KEY,
      prefs TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

    CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_owner_type ON contacts(owner_id, type);
    CREATE INDEX IF NOT EXISTS idx_loads_owner ON loads(owner_id);
    CREATE INDEX IF NOT EXISTS idx_loads_owner_status ON loads(owner_id, status);
    CREATE INDEX IF NOT EXISTS idx_dat_outreach_owner ON dat_outreach(owner_id);
    CREATE INDEX IF NOT EXISTS idx_voice_calls_owner ON voice_calls(owner_id);
    CREATE INDEX IF NOT EXISTS idx_ai_chat_owner ON ai_chat(owner_id);
  `);

  // --- Lightweight migrations: keep old DBs working ---
  await ensureColumn('users', 'email', 'TEXT');
  await ensureColumn('users', 'phone', 'TEXT');
  await ensureColumn('contacts', 'owner_id', 'INTEGER');
  await ensureColumn('loads', 'owner_id', 'INTEGER');
  await ensureColumn('documents', 'drive_file_id', 'TEXT');

  // ── NEW: driver email/phone snapshotted onto the load. Auto-filled from the
  // selected driver contact in the Loads form, still editable per-load. ──
  await ensureColumn('loads', 'driver_email', 'TEXT');
  await ensureColumn('loads', 'driver_phone', 'TEXT');

  // ── NEW: session_token for single-session enforcement ──
  // Safe on every boot — silently ignored if column already exists
  await ensureColumn('users', 'session_token', 'TEXT');

  // ── NEW: password reset token + expiry (forgot-password flow) ──
  await ensureColumn('users', 'reset_token', 'TEXT');
  await ensureColumn('users', 'reset_expires', 'TEXT');

  // ── v3.0: Twilio + Gemini Live voice agent fields on voice_calls ──
  await ensureColumn('voice_calls', 'twilio_call_sid', 'TEXT');
  await ensureColumn('voice_calls', 'stream_sid', 'TEXT');
  await ensureColumn('voice_calls', 'conference_sid', 'TEXT');
  await ensureColumn('voice_calls', 'recording_url', 'TEXT');
  await ensureColumn('voice_calls', 'needs_human', 'INTEGER');
  await ensureColumn('voice_calls', 'alert_reason', 'TEXT');
  await ensureColumn('voice_calls', 'target_rate', 'REAL');
  await ensureColumn('voice_calls', 'min_rate', 'REAL');
  await ensureColumn('voice_calls', 'market_rate', 'REAL');
  await ensureColumn('voice_calls', 'voice', 'TEXT');
  await db.run("UPDATE voice_calls SET needs_human = 0 WHERE needs_human IS NULL");

  // Backfill orphan rows to the first admin so nothing is lost after migration
  const firstAdmin = await db.get("SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1");
  if (firstAdmin && firstAdmin.id) {
    await db.run('UPDATE contacts SET owner_id = ? WHERE owner_id IS NULL', firstAdmin.id);
    await db.run('UPDATE loads SET owner_id = ? WHERE owner_id IS NULL', firstAdmin.id);
  }

  // --- Seed users (only on a brand-new empty DB) ---
  const userCount = (await db.get('SELECT COUNT(*) AS c FROM users')).c;
  if (userCount === 0) {
    const adminPass = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    const info = await db.run(
      `INSERT INTO users (username, password_hash, full_name, role, must_change_password) VALUES (?, ?, ?, 'admin', 0)`,
      ['admin', bcrypt.hashSync(adminPass, 10), 'Administrator']
    );
    const dispatchPass = process.env.DISPATCHER_PASSWORD || 'Dispatch123!';
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, role, must_change_password) VALUES (?, ?, ?, 'dispatcher', 1)`,
      ['dispatcher', bcrypt.hashSync(dispatchPass, 10), 'Dispatcher']
    );
    await seedSampleData(info.lastID);
  }

  return db;
}

async function seedSampleData(ownerId) {
  const carrier = await db.run(
    `INSERT INTO contacts (owner_id, name, company, email, phone, type, manager_name, dispatch_pct) VALUES (?,?,?,?,?,?,?,?)`,
    [ownerId, 'Mark Fleet', 'Apex Logistics', 'ops@apexlogistics.com', '(312) 555-0110', 'carrier', 'Mark Smith', 10.0]
  );
  const cid = carrier.lastID;
  const driver = await db.run(
    `INSERT INTO contacts (owner_id, name, phone, type, parent_carrier_id, cdl_type, has_hazmat, has_twic, truck_unit, truck_type, truck_length, truck_weight) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ownerId, 'John D.', '(312) 555-0199', 'driver', cid, 'CDL-A', 1, 1, 'Unit 101', 'Flatbed', 48, 48000]
  );
  await db.run(
    `INSERT INTO contacts (owner_id, name, company, email, phone, type) VALUES (?,?,?,?,?,?)`,
    [ownerId, 'Sarah Broker', 'TQL', 'sarah@tql.com', '(800) 580-3101', 'broker']
  );
  await db.run(
    `INSERT INTO loads (owner_id, ref, status, broker, broker_email, broker_phone, origin, destination, pickup_date, delivery_date, equipment, miles, rate, dispatch_fee, carrier_id, driver_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ownerId, 'L-SAMPLE', 'delivered', 'TQL', 'sarah@tql.com', '(800) 580-3101', 'Chicago, IL', 'Miami, FL', '2026-08-10', '2026-08-13', 'Flatbed', 1380, 3000, 300, cid, driver.lastID]
  );
}

async function ensureColumn(table, column, type) {
  const cols = await db.all(`PRAGMA table_info(${table})`);
  if (!cols.some(c => c.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

module.exports = { initDb, getDb: () => db, seedSampleData };
