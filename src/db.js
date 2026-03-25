const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const argon2 = require('argon2');

const ARGON2_OPTIONS = { memoryCost: 4096, timeCost: 1, parallelism: 1 };

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

if (!process.env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL environment variable is required');
}

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           SERIAL PRIMARY KEY,
      provider_sub TEXT NOT NULL,
      provider     TEXT NOT NULL DEFAULT 'google',
      email        TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(provider, provider_sub)
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS max_devices INTEGER NOT NULL DEFAULT 5;

    CREATE TABLE IF NOT EXISTS devices (
      id                TEXT PRIMARY KEY,
      user_id           INTEGER NOT NULL REFERENCES users(id),
      name              TEXT NOT NULL,
      device_credential TEXT UNIQUE NOT NULL,
      credential_hashed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen         TIMESTAMPTZ,
      UNIQUE(user_id, name)
    );
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS credential_hashed BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS sessions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     INTEGER NOT NULL REFERENCES users(id),
      token_hash  TEXT UNIQUE NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      revoked     BOOLEAN NOT NULL DEFAULT FALSE,
      ip_address  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    INTEGER REFERENCES users(id),
      device_id  TEXT,
      event      TEXT NOT NULL,
      ip_address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS audit_log_user_id ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS audit_log_created_at ON audit_log(created_at);
  `);
}

async function upsertUser(providerSub, email, provider) {
  const { rows } = await pool.query(
    `INSERT INTO users (provider_sub, provider, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider, provider_sub) DO UPDATE SET email = EXCLUDED.email
     RETURNING *`,
    [providerSub, provider, email]
  );
  return rows[0];
}

async function upsertDeviceByName(userId, name) {
  const rawCredential = crypto.randomBytes(32).toString('hex');
  const credentialHash = await argon2.hash(rawCredential, ARGON2_OPTIONS);

  const existing = await pool.query(
    'SELECT id FROM devices WHERE user_id = $1 AND name = $2',
    [userId, name]
  );

  if (existing.rows[0]) {
    const id = existing.rows[0].id;
    await pool.query(
      'UPDATE devices SET device_credential = $1, credential_hashed = TRUE WHERE id = $2',
      [credentialHash, id]
    );
    return { id, device_credential: rawCredential };
  }

  // New device: enforce per-user limit
  const { rows: [user] } = await pool.query('SELECT max_devices FROM users WHERE id = $1', [userId]);
  const { rows: [{ count }] } = await pool.query('SELECT COUNT(*) FROM devices WHERE user_id = $1', [userId]);
  if (parseInt(count, 10) >= (user?.max_devices ?? 5)) throw new Error('Device limit reached');

  const id = uuidv4();
  await pool.query(
    'INSERT INTO devices (id, user_id, name, device_credential, credential_hashed) VALUES ($1, $2, $3, $4, TRUE)',
    [id, userId, name, credentialHash]
  );
  return { id, device_credential: rawCredential };
}

async function getDeviceByCredential(rawCred, deviceId = null) {
  if (deviceId) {
    // Fast path: look up single row by PK, verify only that one
    const { rows } = await pool.query('SELECT * FROM devices WHERE id = $1 AND credential_hashed = TRUE', [deviceId]);
    if (rows[0] && await argon2.verify(rows[0].device_credential, rawCred)) return rows[0];
    return null; // device_id provided but didn't match — don't fall back to full scan
  }
  // Legacy path: full scan (clients that don't send device_id yet)
  const { rows } = await pool.query('SELECT * FROM devices WHERE credential_hashed = TRUE');
  for (const device of rows) {
    if (await argon2.verify(device.device_credential, rawCred)) return device;
  }
  return null;
}

async function listDevices(userId) {
  const { rows } = await pool.query(
    'SELECT id, user_id, name, created_at, last_seen FROM devices WHERE user_id = $1',
    [userId]
  );
  return rows;
}

async function updateLastSeen(deviceId) {
  await pool.query('UPDATE devices SET last_seen = now() WHERE id = $1', [deviceId]);
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function createSession(userId, tokenHash, ipAddress) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at, ip_address) VALUES ($1, $2, $3, $4)',
    [userId, tokenHash, expiresAt, ipAddress]
  );
}

async function rotateSession(oldTokenHash, newTokenHash, ipAddress) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE sessions SET revoked = TRUE WHERE token_hash = $1 AND revoked = FALSE AND expires_at > now() RETURNING user_id',
      [oldTokenHash]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const userId = rows[0].user_id;
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await client.query(
      'INSERT INTO sessions (user_id, token_hash, expires_at, ip_address) VALUES ($1, $2, $3, $4)',
      [userId, newTokenHash, expiresAt, ipAddress]
    );
    await client.query('COMMIT');
    return userId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function revokeSession(tokenHash) {
  await pool.query('UPDATE sessions SET revoked = TRUE WHERE token_hash = $1', [tokenHash]);
}

async function getDevice(deviceId) {
  const { rows } = await pool.query('SELECT id, user_id FROM devices WHERE id = $1', [deviceId]);
  return rows[0] ?? null;
}

async function deleteDevice(deviceId) {
  await pool.query('DELETE FROM devices WHERE id = $1', [deviceId]);
}

async function deleteAccount(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE sessions SET revoked = TRUE WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM devices WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM audit_log WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function logAudit(userId, deviceId, event, ipAddress) {
  await pool.query(
    'INSERT INTO audit_log (user_id, device_id, event, ip_address) VALUES ($1, $2, $3, $4)',
    [userId ?? null, deviceId ?? null, event, ipAddress ?? null]
  );
}

async function listAuditLog(userId) {
  const { rows } = await pool.query(
    'SELECT id, device_id, event, ip_address, created_at FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
    [userId]
  );
  return rows;
}

async function pruneAuditLog() {
  await pool.query(
    'DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < now() - interval \'90 days\' LIMIT 1000)'
  );
}

module.exports = {
  pool, initSchema,
  upsertUser, upsertDeviceByName, getDeviceByCredential, listDevices, updateLastSeen, getUserById,
  getDevice, deleteDevice, deleteAccount,
  createSession, rotateSession, revokeSession,
  logAudit, listAuditLog, pruneAuditLog,
};
