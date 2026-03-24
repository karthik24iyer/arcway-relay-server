const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const cors = require('cors');
const { handleAgentConnection, handleClientConnection } = require('./relay');
const devicesRouter = require('./devices');

const app = express();
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000'];
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/', devicesRouter);

const server = http.createServer(app);

const wss = new WebSocket.Server({ server, maxPayload: 512 * 1024 });

wss.on('connection', (ws, req) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/agent') {
    handleAgentConnection(ws);
  } else if (pathname === '/client') {
    handleClientConnection(ws);
  } else {
    ws.close(1008, 'Unknown path');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Relay server listening on port ${PORT}`);
});
