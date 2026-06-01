const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function dataDir() {
  return process.env.SQLITE_PATH ? path.dirname(process.env.SQLITE_PATH) : './data';
}

function ensureJwtSecret() {
  if (process.env.JWT_SECRET) return;
  const secretFile = path.join(dataDir(), '.jwt-secret');
  try {
    process.env.JWT_SECRET = fs.readFileSync(secretFile, 'utf8').trim();
    return;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(dataDir(), { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  process.env.JWT_SECRET = secret;
  console.log(`[bootstrap] generated JWT_SECRET at ${secretFile}`);
}

function generatePairCode() {
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, (b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join('');
}

function ensureRelayCode() {
  if (process.env.AUTH_MODE === 'oauth') return;
  if (process.env.RELAY_CODE) return;
  const codeFile = path.join(dataDir(), '.relay-code');
  try {
    process.env.RELAY_CODE = fs.readFileSync(codeFile, 'utf8').trim();
    return;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(dataDir(), { recursive: true });
  const code = generatePairCode();
  fs.writeFileSync(codeFile, code, { mode: 0o600 });
  process.env.RELAY_CODE = code;
  console.log(`\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n  Pair code: ${code}\n  Use this in the Arcway apps to pair devices.\n  Stored at: ${codeFile}\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

function regeneratePairCode() {
  const codeFile = path.join(dataDir(), '.relay-code');
  try { fs.unlinkSync(codeFile); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  delete process.env.RELAY_CODE;
  ensureRelayCode();
  return process.env.RELAY_CODE;
}

module.exports = { ensureJwtSecret, ensureRelayCode, regeneratePairCode };
