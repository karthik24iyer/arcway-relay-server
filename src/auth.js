const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const appleSignin = require('apple-signin-auth');

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

async function verifyAppleToken(identityToken) {
  const payload = await appleSignin.verifyIdToken(identityToken, {
    audience: process.env.APPLE_CLIENT_ID || 'com.clauderemote.claudeRemoteAndroid',
    ignoreExpiration: false,
  });
  // Apple may not return email after first sign-in; use sub as fallback identifier
  const email = payload.email || `${payload.sub}@privaterelay.appleid.com`;
  return { sub: payload.sub, email };
}

module.exports = { verifyGoogleToken, verifyAppleToken, signSessionToken, verifySessionToken };
