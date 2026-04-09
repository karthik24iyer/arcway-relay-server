const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const appleSignin = require('apple-signin-auth');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

const oauthClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function verifyGoogleToken(idToken) {
  const audience = [process.env.GOOGLE_CLIENT_ID, process.env.MAC_CLIENT_ID, process.env.IOS_CLIENT_ID].filter(Boolean);
  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience,
  });
  const payload = ticket.getPayload();
  return { sub: payload.sub, email: payload.email };
}

function signSessionToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '15m' });
}

function verifySessionToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

async function verifyAppleToken(identityToken, audience) {
  const aud = audience || process.env.APPLE_CLIENT_ID || 'com.arcway.app';
  const payload = await appleSignin.verifyIdToken(identityToken, {
    audience: aud,
    ignoreExpiration: false,
  });
  // Apple may not return email after first sign-in; use sub as fallback identifier
  const email = payload.email || `${payload.sub}@privaterelay.appleid.com`;
  return { sub: payload.sub, email };
}

function generateAppleClientSecret() {
  const privateKey = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return jwt.sign({}, privateKey, {
    algorithm: 'ES256',
    expiresIn: '1h',
    audience: 'https://appleid.apple.com',
    issuer: process.env.APPLE_TEAM_ID,
    subject: process.env.APPLE_MAC_CLIENT_ID,
    keyid: process.env.APPLE_KEY_ID,
  });
}

async function exchangeAppleCode(authorizationCode) {
  const clientSecret = generateAppleClientSecret();
  const params = new URLSearchParams({
    client_id: process.env.APPLE_MAC_CLIENT_ID,
    client_secret: clientSecret,
    code: authorizationCode,
    grant_type: 'authorization_code',
    redirect_uri: process.env.APPLE_REDIRECT_URI,
  });

  const res = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const json = await res.json();
  if (!json.id_token) throw new Error('Apple token exchange failed');
  return json.id_token;
}

module.exports = { verifyGoogleToken, verifyAppleToken, signSessionToken, verifySessionToken, exchangeAppleCode };
