require('dotenv').config();

const bootstrap = require('./bootstrap');
bootstrap.ensureJwtSecret();
bootstrap.ensureRelayCode();

const { createRelay } = require('./createRelay');

const relay = createRelay({
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000'],
  port: process.env.PORT || 3000,
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down`);
  try {
    await relay.stop();
    process.exit(0);
  } catch (err) {
    console.error('Shutdown error:', err);
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

relay.start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
