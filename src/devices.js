const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifyGoogleToken, verifyAppleToken, signSessionToken, verifySessionToken } = require('./auth');
const { upsertUser, listDevices, upsertDeviceByName } = require('./db');
const { connectedAgents } = require('./relay');

const router = express.Router();

const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const apiRateLimit = rateLimit({ windowMs: 60 * 1000, max: 100 });
const refreshRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const { userId } = verifySessionToken(token);
    req.userId = userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

router.post('/auth/google', authRateLimit, async (req, res) => {
  try {
    const { id_token } = req.body;
    const { sub, email } = await verifyGoogleToken(id_token);
    const user = upsertUser(sub, email, 'google');
    const session_token = signSessionToken(user.id, email);
    res.json({ session_token });
  } catch (err) {
    console.error('/auth/google error:', err.message);
    res.status(401).json({ error: err.message });
  }
});

router.post('/auth/apple', authRateLimit, async (req, res) => {
  try {
    const { identity_token } = req.body;
    const { sub, email } = await verifyAppleToken(identity_token);
    const user = upsertUser(sub, email, 'apple');
    const session_token = signSessionToken(user.id, email);
    res.json({ session_token });
  } catch (err) {
    console.error('/auth/apple error:', err.message);
    res.status(401).json({ error: err.message });
  }
});

router.post('/auth/refresh', refreshRateLimit, (req, res) => res.status(404).json({ error: 'Not implemented' }));

router.get('/api/devices', apiRateLimit, authMiddleware, (req, res) => {
  const devices = listDevices(req.userId).map((d) => ({
    ...d,
    online: connectedAgents.has(d.id),
  }));
  res.json({ devices });
});

router.post('/api/devices/register', apiRateLimit, authMiddleware, (req, res) => {
  const rawName = req.body?.name || 'My Mac';
  const name = rawName.replace(/[^\x20-\x7E]/g, '').slice(0, 50) || 'My Mac';
  const { id, device_credential } = upsertDeviceByName(req.userId, name);
  res.json({ device_id: id, device_credential });
});

module.exports = router;
