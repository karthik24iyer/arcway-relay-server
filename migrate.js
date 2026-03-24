// One-off SQLite -> PostgreSQL migration script for Milestone 2.
// Usage: POSTGRES_URL=... node migrate.js [--sqlite-path /path/to/relay.db]
// Run only while relay server is stopped.

const Database = require('better-sqlite3');
const { Pool } = require('pg');
const path = require('path');
const os = require('os');

const sqlitePath = (() => {
  const idx = process.argv.indexOf('--sqlite-path');
  return idx !== -1 ? process.argv[idx + 1] : path.join(os.homedir(), '.arcway-remote', 'relay.db');
})();

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is required');
  process.exit(1);
}

const sqlite = new Database(sqlitePath, { readonly: true });
const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

async function migrate() {
  const users = sqlite.prepare('SELECT * FROM users').all();
  const devices = sqlite.prepare('SELECT * FROM devices').all();

  console.log(`SQLite: ${users.length} users, ${devices.length} devices`);

  const client = await pool.connect();
  try {
    await client.query(`
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
    `);

    await client.query('BEGIN');

    for (const u of users) {
      await client.query(
        `INSERT INTO users (id, provider_sub, provider, email, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (provider, provider_sub) DO NOTHING`,
        [u.id, u.provider_sub || u.google_sub, u.provider || 'google', u.email, u.created_at]
      );
    }

    for (const d of devices) {
      await client.query(
        `INSERT INTO devices (id, user_id, name, device_credential, created_at, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [d.id, d.user_id, d.name, d.device_credential, d.created_at, d.last_seen || null]
      );
    }

    // Fix SERIAL sequence to avoid PK collisions on new inserts
    await client.query(`SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 1))`);

    await client.query('COMMIT');
    console.log('Migration committed.');

    const { rows: pgUsers } = await client.query('SELECT COUNT(*) FROM users');
    const { rows: pgDevices } = await client.query('SELECT COUNT(*) FROM devices');
    console.log(`PostgreSQL: ${pgUsers[0].count} users, ${pgDevices[0].count} devices`);

    if (parseInt(pgUsers[0].count) !== users.length || parseInt(pgDevices[0].count) !== devices.length) {
      console.error('Row count mismatch — verify manually before starting the server');
      process.exit(1);
    }
    console.log('Row counts match. Migration successful.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed, rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

migrate();
