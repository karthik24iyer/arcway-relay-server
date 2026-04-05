const { WebSocket } = require('ws');
const { getDeviceByCredential, updateLastSeen, listDevices, getUserById, getUserConfig, logAudit } = require('./db');
const { verifySessionToken } = require('./auth');

function getIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? null;
}

const connectedAgents = new Map(); // deviceId -> ws
const bridgedAgents = new Map();   // deviceId -> clientWs

function sanitizeName(name) {
  return name.replace(/[^\x20-\x7E]/g, '').slice(0, 50) || 'My Mac';
}

// Heartbeat intervals and pong timeout tuned to survive nginx TLS proxy round-trip jitter.
// 30 s ping interval, 15 s pong deadline = 45 s max before a dead connection is declared.
const AGENT_PING_INTERVAL  = 30_000;
const CLIENT_PING_INTERVAL = 30_000;
const PONG_DEADLINE        = 15_000;

function startHeartbeat(ws, deviceId) {
  let pongTimer = null;
  const onPong = () => {
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    updateLastSeen(deviceId).catch((err) => console.error(`updateLastSeen failed: ${deviceId}`, err));
  };
  ws.on('pong', onPong);
  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) { clearInterval(interval); return; }
    ws.ping();
    pongTimer = setTimeout(() => {
      console.log(`[${new Date().toISOString()}] Agent heartbeat timeout: ${deviceId}`);
      ws.terminate();
    }, PONG_DEADLINE);
  }, AGENT_PING_INTERVAL);
  ws.once('close', () => {
    clearInterval(interval);
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    ws.removeListener('pong', onPong);
  });
}

function startClientHeartbeat(ws, deviceId) {
  let pongTimer = null;
  const onPong = () => {
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  };
  ws.on('pong', onPong);
  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) { clearInterval(interval); return; }
    ws.ping();
    pongTimer = setTimeout(() => {
      console.log(`[${new Date().toISOString()}] Client heartbeat timeout: ${deviceId}`);
      ws.terminate();
    }, PONG_DEADLINE);
  }, CLIENT_PING_INTERVAL);
  ws.once('close', () => {
    clearInterval(interval);
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    ws.removeListener('pong', onPong);
  });
}

function withAuthTimeout(ws, onMessage) {
  const t = setTimeout(() => ws.close(1008, 'Auth timeout'), 10_000);
  const cancelTimeout = () => clearTimeout(t);
  ws.once('close', cancelTimeout);
  ws.once('message', async (data) => {
    clearTimeout(t);
    ws.removeListener('close', cancelTimeout);
    let msg;
    try { msg = JSON.parse(data); } catch { ws.close(1008, 'Invalid JSON'); return; }
    if (msg.type !== 'auth') { ws.close(1008, 'Expected auth message'); return; }
    await onMessage(msg);
  });
}

function handleAgentConnection(ws, req) {
  const ip = getIp(req);
  let logId = '';
  ws.on('error', (err) => console.error(`Agent ws error ${logId}:`, err));
  withAuthTimeout(ws, async (msg) => {
    try {
      if (!msg.device_credential) { ws.close(1008, 'Missing device_credential'); return; }
      const device = await getDeviceByCredential(msg.device_credential, msg.device_id || null);
      if (!device) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid credential' }));
        ws.close(1008, 'Invalid credential');
        return;
      }
      if (msg.name) device.name = sanitizeName(msg.name);
      await updateLastSeen(device.id);
      logId = device.id;
      // evict orphaned socket for same device (zombie TCP reconnect)
      const existing = connectedAgents.get(device.id);
      if (existing && existing !== ws && existing.readyState !== WebSocket.CLOSED) {
        // synchronously clean stale bridge so new clients aren't spuriously rejected
        const staleClient = bridgedAgents.get(device.id);
        if (staleClient) {
          bridgedAgents.delete(device.id);
          if (staleClient.readyState === WebSocket.OPEN) staleClient.close(1001, 'Agent reconnected');
        }
        existing.terminate();
      }
      connectedAgents.set(device.id, ws);
      console.log(`[${new Date().toISOString()}] Agent connected: ${device.id} (${device.name})`);
      ws.send(JSON.stringify({ type: 'authenticated', device_id: device.id }));
      logAudit(device.user_id, device.id, 'agent_connected', ip).catch((err) => console.error('logAudit failed:', err));
      startHeartbeat(ws, device.id);
      ws.once('close', (code, reason) => {
        if (connectedAgents.get(device.id) === ws) {
          connectedAgents.delete(device.id);
          console.log(`[${new Date().toISOString()}] Agent disconnected: ${device.id} code=${code} reason=${reason?.toString() || ''}`);
          logAudit(device.user_id, device.id, 'agent_disconnected', ip).catch((err) => console.error('logAudit failed:', err));
        }
      });
    } catch (err) {
      console.error('Agent auth error:', err);
      ws.close(1011, 'Internal error');
    }
  });
}

function handleClientConnection(ws, req) {
  const ip = getIp(req);
  let logId = '';
  ws.on('error', (err) => console.error(`Client ws error ${logId}:`, err));
  withAuthTimeout(ws, async (msg) => {
    logId = msg.device_id ?? '';
    let agentWs, onClientMessage, onAgentMessage, onAgentClose, onClientClose;
    try {
      let userId;
      try {
        ({ userId } = verifySessionToken(msg.session_token));
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid session token' }));
        ws.close(1008, 'Invalid session token');
        return;
      }

      const devices = await listDevices(userId);
      const device = devices.find((d) => d.id === msg.device_id);
      if (!device) {
        ws.send(JSON.stringify({ type: 'error', message: 'Device not found or not owned by user' }));
        ws.close(1008, 'Device not found');
        return;
      }

      // getUserById + getUserConfig before agentWs lookup — keeps agentWs fresh (no await after this point)
      const [user, userConfig] = await Promise.all([
        getUserById(userId).catch((err) => { console.error(`getUserById failed for ${userId}:`, err); return null; }),
        getUserConfig(userId).catch((err) => { console.error(`getUserConfig failed for ${userId}:`, err); return { max_sessions: 5 }; }),
      ]);

      agentWs = connectedAgents.get(msg.device_id);
      if (!agentWs || agentWs.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: 'Device offline' }));
        ws.close(1001, 'Device offline');
        return;
      }

      // Evict any stale bridge — handles reconnect where OS killed the socket without
      // sending a close frame (bridgedAgents would still hold the dead WS for up to
      // ~17 s until heartbeat timeout). Same approach as agent eviction above.
      const existingClient = bridgedAgents.get(msg.device_id);
      if (existingClient) {
        bridgedAgents.delete(msg.device_id);
        if (existingClient.readyState === WebSocket.OPEN) existingClient.close(1001, 'Connection superseded');
      }
      bridgedAgents.set(msg.device_id, ws);
      // guard: agent may have closed between awaits above and bridgedAgents.set
      if (agentWs.readyState !== WebSocket.OPEN) {
        bridgedAgents.delete(msg.device_id);
        ws.send(JSON.stringify({ type: 'error', message: 'Device offline' }));
        ws.close(1001, 'Device offline');
        return;
      }

      agentWs.setMaxListeners(7); // canary: 6 real listeners + 1 headroom
      startClientHeartbeat(ws, msg.device_id);
      console.log(`[${new Date().toISOString()}] Client bridged to agent: ${msg.device_id}`);

      onClientMessage = (chunk) => { if (agentWs.readyState === WebSocket.OPEN) agentWs.send(chunk); };
      onAgentMessage = (chunk) => { if (ws.readyState === WebSocket.OPEN) ws.send(chunk); };
      onAgentClose = () => {
        // identity guard: stale closure from agent reconnect must not evict a newer bridge
        if (bridgedAgents.get(msg.device_id) === ws) bridgedAgents.delete(msg.device_id);
        ws.removeListener('message', onClientMessage);
        ws.removeListener('close', onClientClose);
        agentWs.removeListener('message', onAgentMessage);
        agentWs.removeListener('close', onAgentClose);
        if (ws.readyState === WebSocket.OPEN) ws.close(1001, 'Agent disconnected');
      };
      onClientClose = () => {
        if (bridgedAgents.get(msg.device_id) === ws) bridgedAgents.delete(msg.device_id);
        ws.removeListener('message', onClientMessage);
        ws.removeListener('close', onClientClose);
        agentWs.removeListener('message', onAgentMessage);
        agentWs.removeListener('close', onAgentClose);
        console.log(`[${new Date().toISOString()}] Client disconnected from agent: ${msg.device_id}`);
        logAudit(userId, msg.device_id, 'client_disconnected', ip).catch((err) => console.error('logAudit failed:', err));
      };

      ws.on('message', onClientMessage);
      agentWs.on('message', onAgentMessage);
      agentWs.on('close', onAgentClose);
      ws.on('close', onClientClose);

      ws.send(JSON.stringify({ type: 'user_config', max_sessions: userConfig.max_sessions }));
      if (agentWs.readyState === WebSocket.OPEN) {
        agentWs.send(JSON.stringify({ type: 'client_connected', user_email: user?.email ?? '' }));
      }
      logAudit(userId, msg.device_id, 'client_connected', ip).catch((err) => console.error('logAudit failed:', err));
    } catch (err) {
      console.error('Client auth error:', err);
      if (msg?.device_id && bridgedAgents.get(msg.device_id) === ws) bridgedAgents.delete(msg.device_id);
      if (onClientMessage) ws.removeListener('message', onClientMessage);
      if (onClientClose) ws.removeListener('close', onClientClose);
      if (agentWs) {
        if (onAgentMessage) agentWs.removeListener('message', onAgentMessage);
        if (onAgentClose) agentWs.removeListener('close', onAgentClose);
      }
      ws.close(1011, 'Internal error');
    }
  });
}

module.exports = { connectedAgents, sanitizeName, handleAgentConnection, handleClientConnection, getIp };
