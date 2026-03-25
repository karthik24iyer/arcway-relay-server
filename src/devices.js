const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { verifyGoogleToken, verifyAppleToken, signSessionToken, verifySessionToken } = require('./auth');
const { upsertUser, listDevices, upsertDeviceByName, createSession, rotateSession, revokeSession } = require('./db');
const { connectedAgents, sanitizeName } = require('./relay');

const router = express.Router();

const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const apiRateLimit = rateLimit({ windowMs: 60 * 1000, max: 100 });
const refreshRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const { userId } = verifySessionToken(token);
    if (!userId || typeof userId !== 'number') return res.status(401).json({ error: 'Invalid token' });
    req.userId = userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

router.get('/health', (req, res) => res.json({ status: 'ok' }));

async function issueTokens(userId, ipAddress) {
  const session_token = signSessionToken(userId);
  const rawRefresh = crypto.randomBytes(32).toString('hex');
  await createSession(userId, hashToken(rawRefresh), ipAddress);
  return { session_token, refresh_token: rawRefresh };
}

async function handleOAuthLogin(req, res, verifyFn, provider, tokenField) {
  try {
    const { sub, email } = await verifyFn(req.body[tokenField]);
    const user = await upsertUser(sub, email, provider);
    res.json({ ...(await issueTokens(user.id, req.ip)), email });
  } catch (err) {
    console.error(`/auth/${provider} error:`, err);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

router.post('/auth/google', authRateLimit, (req, res) => handleOAuthLogin(req, res, verifyGoogleToken, 'google', 'id_token'));
router.post('/auth/apple', authRateLimit, (req, res) => handleOAuthLogin(req, res, verifyAppleToken, 'apple', 'identity_token'));

router.post('/auth/refresh', refreshRateLimit, async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Missing refresh_token' });
    const newRawRefresh = crypto.randomBytes(32).toString('hex');
    const userId = await rotateSession(hashToken(refresh_token), hashToken(newRawRefresh), req.ip);
    if (!userId) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    res.json({ session_token: signSessionToken(userId), refresh_token: newRawRefresh });
  } catch (err) {
    console.error('/auth/refresh error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/auth/logout', async (req, res) => {
  try {
    if (req.body?.refresh_token) await revokeSession(hashToken(req.body.refresh_token));
  } catch (err) {
    console.error('/auth/logout error:', err);
  }
  res.json({ ok: true }); // always 200
});

router.get('/api/devices', apiRateLimit, authMiddleware, async (req, res) => {
  try {
    const raw = await listDevices(req.userId);
    res.json({ devices: raw.map((d) => ({ ...d, online: connectedAgents.has(d.id) })) });
  } catch (err) {
    console.error('/api/devices error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/api/devices/register', apiRateLimit, authMiddleware, async (req, res) => {
  try {
    const name = sanitizeName(req.body?.name || '');
    const { id, device_credential } = await upsertDeviceByName(req.userId, name);
    res.json({ device_id: id, device_credential });
  } catch (err) {
    console.error('/api/devices/register error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
