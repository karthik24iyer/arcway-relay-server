const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const cors = require('cors');
const { handleAgentConnection, handleClientConnection, getIp } = require('./relay');
const devicesRouter = require('./devices');
const { pool, initSchema, pruneAuditLog } = require('./db');

const app = express();
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000'];
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/', devicesRouter);

const server = http.createServer(app);

const wss = new WebSocket.Server({ server, maxPayload: 512 * 1024 });

const WS_MAX_PER_IP = 20;
const wsCountByIp = new Map(); // ip -> active connection count

wss.on('connection', (ws, req) => {
  const ip = getIp(req) ?? 'unknown';
  const count = (wsCountByIp.get(ip) ?? 0) + 1;
  if (count > WS_MAX_PER_IP) {
    ws.close(1008, 'Too many connections');
    return;
  }
  wsCountByIp.set(ip, count);
  ws.on('close', () => {
    const c = (wsCountByIp.get(ip) ?? 1) - 1;
    if (c <= 0) wsCountByIp.delete(ip);
    else wsCountByIp.set(ip, c);
  });

  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/agent') {
    handleAgentConnection(ws, req);
  } else if (pathname === '/client') {
    handleClientConnection(ws, req);
  } else {
    ws.close(1008, 'Unknown path');
  }
});

const PORT = process.env.PORT || 3000;
pool.connect()
  .then(async (client) => {
    client.release();
    await initSchema();
    server.listen(PORT, () => console.log(`Relay server listening on port ${PORT}`));
    setInterval(() => pruneAuditLog().catch((err) => console.error('pruneAuditLog failed:', err)), 24 * 60 * 60 * 1000);
  })
  .catch((err) => {
    console.error('DB connection failed:', err);
    process.exit(1);
  });
