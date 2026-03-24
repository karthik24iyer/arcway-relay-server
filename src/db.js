const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

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

    CREATE TABLE IF NOT EXISTS devices (
      id                TEXT PRIMARY KEY,
      user_id           INTEGER NOT NULL REFERENCES users(id),
      name              TEXT NOT NULL,
      device_credential TEXT UNIQUE NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen         TIMESTAMPTZ,
      UNIQUE(user_id, name)
    );

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
  const id = uuidv4();
  const device_credential = crypto.randomBytes(32).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO devices (id, user_id, name, device_credential)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, name) DO UPDATE SET device_credential = devices.device_credential
     RETURNING id, device_credential`,
    [id, userId, name, device_credential]
  );
  return { id: rows[0].id, device_credential: rows[0].device_credential };
}

async function getDeviceByCredential(cred) {
  const { rows } = await pool.query(
    'SELECT * FROM devices WHERE device_credential = $1',
    [cred]
  );
  return rows[0] ?? null;
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

module.exports = { pool, initSchema, upsertUser, upsertDeviceByName, getDeviceByCredential, listDevices, updateLastSeen, getUserById, createSession, rotateSession, revokeSession };
