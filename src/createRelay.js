const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const cors = require('cors');
const { handleAgentConnection, handleClientConnection, getIp, setHooks } = require('./relay');
const devicesRouter = require('./devices');
const defaultStorage = require('./storage');

const WS_MAX_PER_IP = 20;

function createRelay({
  storage = defaultStorage,
  hooks = {},
  allowedOrigins = ['http://localhost:3000'],
  port = 3000,
} = {}) {
  setHooks(hooks);

  const app = express();
  app.set('trust proxy', 1);
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json({ limit: '10kb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/', devicesRouter);

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, maxPayload: 512 * 1024 });

  const wsCountByIp = new Map();
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
    if (pathname === '/agent') handleAgentConnection(ws, req);
    else if (pathname === '/client') handleClientConnection(ws, req);
    else ws.close(1008, 'Unknown path');
  });

  let pruneTimer;
  return {
    app, server, wss,
    async start() {
      await storage.init();
      await new Promise((resolve) => server.listen(port, resolve));
      pruneTimer = setInterval(
        () => storage.pruneAuditLog().catch((err) => console.error('pruneAuditLog failed:', err)),
        24 * 60 * 60 * 1000
      );
      console.log(`Relay server listening on port ${port}`);
    },
    async stop() {
      if (pruneTimer) clearInterval(pruneTimer);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createRelay };
