const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const argon2 = require('argon2');

const ARGON2_OPTIONS = { memoryCost: 4096, timeCost: 1, parallelism: 1 };
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const dbPath = process.env.SQLITE_PATH || './data/relay.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const nowIso = () => new Date().toISOString();

async function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_sub TEXT NOT NULL,
      provider     TEXT NOT NULL DEFAULT 'google',
      email        TEXT NOT NULL,
      max_devices  INTEGER NOT NULL DEFAULT 9999,
      max_sessions INTEGER NOT NULL DEFAULT 9999,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(provider, provider_sub)
    );

    CREATE TABLE IF NOT EXISTS devices (
      id                TEXT PRIMARY KEY,
      user_id           INTEGER NOT NULL REFERENCES users(id),
      name              TEXT NOT NULL,
      device_credential TEXT UNIQUE NOT NULL,
      credential_hashed INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_seen         TEXT,
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      token_hash  TEXT UNIQUE NOT NULL,
      expires_at  TEXT NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0,
      ip_address  TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id         TEXT PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id),
      device_id  TEXT,
      event      TEXT NOT NULL,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS audit_log_user_id ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS audit_log_created_at ON audit_log(created_at);
  `);
}

async function countUsers() {
  return db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
}

async function countActiveSessions() {
  return db.prepare(
    "SELECT COUNT(*) AS count FROM sessions WHERE revoked = 0 AND expires_at > ?"
  ).get(nowIso()).count;
}

async function purgeAll() {
  db.transaction(() => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM devices').run();
    db.prepare('DELETE FROM audit_log').run();
    db.prepare('DELETE FROM users').run();
  })();
}

async function getOrCreateSingletonUser() {
  return db.prepare(`
    INSERT INTO users (provider_sub, provider, email)
    VALUES ('singleton', 'pair', 'self-host@local')
    ON CONFLICT (provider, provider_sub) DO UPDATE SET email = excluded.email
    RETURNING *
  `).get();
}

async function upsertUser(providerSub, email, provider) {
  return db.prepare(`
    INSERT INTO users (provider_sub, provider, email) VALUES (?, ?, ?)
    ON CONFLICT (provider, provider_sub) DO UPDATE SET email = excluded.email
    RETURNING *
  `).get(providerSub, provider, email);
}

async function upsertDeviceByName(userId, name) {
  const rawCredential = crypto.randomBytes(32).toString('hex');
  const credentialHash = await argon2.hash(rawCredential, ARGON2_OPTIONS);

  const existing = db.prepare('SELECT id FROM devices WHERE user_id = ? AND name = ?').get(userId, name);
  if (existing) {
    db.prepare('UPDATE devices SET device_credential = ?, credential_hashed = 1 WHERE id = ?')
      .run(credentialHash, existing.id);
    return { id: existing.id, device_credential: rawCredential };
  }

  const user = db.prepare('SELECT max_devices FROM users WHERE id = ?').get(userId);
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM devices WHERE user_id = ?').get(userId);
  if (count >= (user?.max_devices ?? 9999)) throw new Error('Device limit reached');

  const id = uuidv4();
  db.prepare('INSERT INTO devices (id, user_id, name, device_credential, credential_hashed) VALUES (?, ?, ?, ?, 1)')
    .run(id, userId, name, credentialHash);
  return { id, device_credential: rawCredential };
}

async function getDeviceByCredential(rawCred, deviceId = null) {
  if (deviceId) {
    const row = db.prepare('SELECT * FROM devices WHERE id = ? AND credential_hashed = 1').get(deviceId);
    if (row && await argon2.verify(row.device_credential, rawCred)) return row;
    return null;
  }
  const rows = db.prepare('SELECT * FROM devices WHERE credential_hashed = 1').all();
  for (const device of rows) {
    if (await argon2.verify(device.device_credential, rawCred)) return device;
  }
  return null;
}

async function listDevices(userId) {
  return db.prepare('SELECT id, user_id, name, created_at, last_seen FROM devices WHERE user_id = ?').all(userId);
}

async function updateLastSeen(deviceId) {
  db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(nowIso(), deviceId);
}

async function getUserById(id) {
  return db.prepare('SELECT email, max_sessions FROM users WHERE id = ?').get(id) ?? null;
}

async function createSession(userId, tokenHash, ipAddress) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, ip_address) VALUES (?, ?, ?, ?, ?)')
    .run(uuidv4(), userId, tokenHash, expiresAt, ipAddress);
}

async function rotateSession(oldTokenHash, newTokenHash, ipAddress) {
  const txn = db.transaction(() => {
    const row = db.prepare(
      'UPDATE sessions SET revoked = 1 WHERE token_hash = ? AND revoked = 0 AND expires_at > ? RETURNING user_id'
    ).get(oldTokenHash, nowIso());
    if (!row) return null;
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, ip_address) VALUES (?, ?, ?, ?, ?)')
      .run(uuidv4(), row.user_id, newTokenHash, expiresAt, ipAddress);
    return row.user_id;
  });
  return txn();
}

async function revokeSession(tokenHash) {
  db.prepare('UPDATE sessions SET revoked = 1 WHERE token_hash = ?').run(tokenHash);
}

async function getDevice(deviceId) {
  return db.prepare('SELECT id, user_id FROM devices WHERE id = ?').get(deviceId) ?? null;
}

async function deleteDevice(deviceId) {
  db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
}

async function deleteAccount(userId) {
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM devices WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM audit_log WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();
}

async function logAudit(userId, deviceId, event, ipAddress) {
  db.prepare('INSERT INTO audit_log (id, user_id, device_id, event, ip_address) VALUES (?, ?, ?, ?, ?)')
    .run(uuidv4(), userId ?? null, deviceId ?? null, event, ipAddress ?? null);
}

async function listAuditLog(userId) {
  return db.prepare(
    'SELECT id, device_id, event, ip_address, created_at FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  ).all(userId);
}

async function pruneAuditLog() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    'DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < ? LIMIT 1000)'
  ).run(cutoff);
}

module.exports = {
  init,
  countUsers, countActiveSessions, purgeAll, getOrCreateSingletonUser,
  upsertUser, upsertDeviceByName, getDeviceByCredential, listDevices, updateLastSeen, getUserById,
  getDevice, deleteDevice, deleteAccount,
  createSession, rotateSession, revokeSession,
  logAudit, listAuditLog, pruneAuditLog,
};
