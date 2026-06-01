#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (!args.includes('--confirm')) {
  console.error('Refusing to run without --confirm. This purges all users, devices, sessions, and audit log.');
  console.error('Usage: node src/reset.js --confirm [--regenerate-code]');
  process.exit(1);
}

require('./bootstrap').ensureJwtSecret();
require('./bootstrap').ensureRelayCode();

const storage = require('./storage');

(async () => {
  await storage.init();
  const before = await storage.countUsers();
  if (storage.pool) {
    await storage.pool.query('DELETE FROM sessions; DELETE FROM devices; DELETE FROM audit_log; DELETE FROM users;');
  } else {
    require('better-sqlite3');
    const dbPath = process.env.SQLITE_PATH || '/data/relay.db';
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.transaction(() => {
      db.prepare('DELETE FROM sessions').run();
      db.prepare('DELETE FROM devices').run();
      db.prepare('DELETE FROM audit_log').run();
      db.prepare('DELETE FROM users').run();
    })();
    db.close();
  }
  console.log(`Purged ${before} users (and all their devices/sessions/audit rows).`);

  if (args.includes('--regenerate-code')) {
    const codeFile = path.join(process.env.SQLITE_PATH ? path.dirname(process.env.SQLITE_PATH) : '/data', '.relay-code');
    try { fs.unlinkSync(codeFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    delete process.env.RELAY_CODE;
    require('./bootstrap').ensureRelayCode();
  } else {
    console.log(`Pair code unchanged: ${process.env.RELAY_CODE}`);
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
