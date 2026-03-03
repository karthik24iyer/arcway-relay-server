const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const dbDir = path.dirname(process.env.DB_PATH || path.join(os.homedir(), '.claude-remote', 'relay.db'));
fs.mkdirSync(dbDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(os.homedir(), '.claude-remote', 'relay.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    device_credential TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL,
    last_seen TEXT
  );

  CREATE TABLE IF NOT EXISTS link_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL
  );
`);

function upsertUser(googleSub, email) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (google_sub, email, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email
  `).run(googleSub, email, now);
  return db.prepare('SELECT * FROM users WHERE google_sub = ?').get(googleSub);
}

function createDevice(userId, name) {
  const id = uuidv4();
  const device_credential = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO devices (id, user_id, name, device_credential, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, userId, name, device_credential, now);
  return { id, device_credential };
}

function upsertDeviceByName(userId, name) {
  const existing = db.prepare('SELECT * FROM devices WHERE user_id = ? AND name = ?').get(userId, name);
  if (existing) return { id: existing.id, device_credential: existing.device_credential };
  return createDevice(userId, name);
}

function getDeviceByCredential(cred) {
  return db.prepare('SELECT * FROM devices WHERE device_credential = ?').get(cred);
}

function createLinkToken(userId) {
  const token = crypto.randomBytes(16).toString('hex');
  const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO link_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires_at);
  return token;
}

function consumeLinkToken(token) {
  const row = db.prepare('SELECT * FROM link_tokens WHERE token = ?').get(token);
  if (!row) return null;
  db.prepare('DELETE FROM link_tokens WHERE token = ?').run(token);
  if (new Date(row.expires_at) < new Date()) return null;
  return row.user_id;
}

function listDevices(userId) {
  return db.prepare('SELECT id, user_id, name, created_at, last_seen FROM devices WHERE user_id = ?').all(userId);
}

function updateLastSeen(deviceId) {
  db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), deviceId);
}

module.exports = { upsertUser, createDevice, upsertDeviceByName, getDeviceByCredential, createLinkToken, consumeLinkToken, listDevices, updateLastSeen };
