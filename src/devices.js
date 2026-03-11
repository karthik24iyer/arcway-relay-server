const express = require('express');
const { verifyGoogleToken, verifyAppleToken, signSessionToken, verifySessionToken } = require('./auth');
const { upsertUser, listDevices, createLinkToken, upsertDeviceByName } = require('./db');
const { connectedAgents } = require('./relay');

const router = express.Router();

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const { userId, email } = verifySessionToken(token);
    req.userId = userId;
    req.email = email;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

router.post('/auth/google', async (req, res) => {
  try {
    const { id_token } = req.body;
    const { sub, email } = await verifyGoogleToken(id_token);
    const user = upsertUser(sub, email);
    const session_token = signSessionToken(user.id, email);
    res.json({ session_token });
  } catch (err) {
    console.error('/auth/google error:', err.message);
    res.status(401).json({ error: err.message });
  }
});

router.post('/auth/apple', async (req, res) => {
  try {
    const { identity_token } = req.body;
    const { sub, email } = await verifyAppleToken(identity_token);
    const user = upsertUser(sub, email);
    const session_token = signSessionToken(user.id, email);
    res.json({ session_token });
  } catch (err) {
    console.error('/auth/apple error:', err.message);
    res.status(401).json({ error: err.message });
  }
});

router.get('/api/devices', authMiddleware, (req, res) => {
  const devices = listDevices(req.userId).map((d) => ({
    ...d,
    online: connectedAgents.has(d.id),
  }));
  res.json({ devices });
});

router.post('/api/devices/register', authMiddleware, (req, res) => {
  const name = req.body?.name || 'My Mac';
  const { id, device_credential } = upsertDeviceByName(req.userId, name);
  res.json({ device_id: id, device_credential });
});

router.post('/api/devices/link-token', authMiddleware, (req, res) => {
  const token = createLinkToken(req.userId);
  res.json({ token });
});

module.exports = router;
