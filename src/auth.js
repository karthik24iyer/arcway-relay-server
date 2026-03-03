const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

const oauthClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function verifyGoogleToken(idToken) {
  const audience = [process.env.GOOGLE_CLIENT_ID, process.env.MAC_CLIENT_ID].filter(Boolean);
  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience,
  });
  const payload = ticket.getPayload();
  return { sub: payload.sub, email: payload.email };
}

function signSessionToken(userId, email) {
  return jwt.sign({ userId, email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

function verifySessionToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

module.exports = { verifyGoogleToken, signSessionToken, verifySessionToken };
