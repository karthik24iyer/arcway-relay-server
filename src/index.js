const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { handleAgentConnection, handleClientConnection } = require('./relay');
const devicesRouter = require('./devices');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use('/', devicesRouter);

const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

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
