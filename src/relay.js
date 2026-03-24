const { WebSocket } = require('ws');
const { getDeviceByCredential, updateLastSeen, listDevices, getUserById } = require('./db');
const { verifySessionToken } = require('./auth');

const connectedAgents = new Map(); // deviceId -> ws
const bridgedAgents = new Map();   // deviceId -> clientWs

function sanitizeName(name) {
  return name.replace(/[^\x20-\x7E]/g, '').slice(0, 50) || 'My Mac';
}

function startHeartbeat(ws, deviceId) {
  let alive = true;
  const onPong = () => {
    alive = true;
    updateLastSeen(deviceId).catch((err) => console.error(`updateLastSeen failed: ${deviceId}`, err));
  };
  ws.on('pong', onPong);
  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) { clearInterval(interval); return; }
    if (!alive) {
      console.log(`Agent heartbeat timeout: ${deviceId}`);
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 5000);
  ws.once('close', () => {
    clearInterval(interval);
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

function handleAgentConnection(ws) {
  let logId = '';
  ws.on('error', (err) => console.error(`Agent ws error ${logId}:`, err));
  withAuthTimeout(ws, async (msg) => {
    try {
      if (!msg.device_credential) { ws.close(1008, 'Missing device_credential'); return; }
      const device = await getDeviceByCredential(msg.device_credential);
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
      console.log(`Agent connected: ${device.id} (${device.name})`);
      ws.send(JSON.stringify({ type: 'authenticated', device_id: device.id }));
      startHeartbeat(ws, device.id);
      ws.once('close', () => {
        if (connectedAgents.get(device.id) === ws) {
          connectedAgents.delete(device.id);
          console.log(`Agent disconnected: ${device.id}`);
        }
      });
    } catch (err) {
      console.error('Agent auth error:', err);
      ws.close(1011, 'Internal error');
    }
  });
}

function handleClientConnection(ws) {
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

      // getUserById before agentWs lookup — keeps agentWs fresh (no await after this point)
      const user = await getUserById(userId).catch((err) => {
        console.error(`getUserById failed for ${userId}:`, err);
        return null;
      });

      agentWs = connectedAgents.get(msg.device_id);
      if (!agentWs || agentWs.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: 'Device offline' }));
        ws.close(1001, 'Device offline');
        return;
      }

      // check+set with no await between — eliminates TOCTOU race
      if (bridgedAgents.has(msg.device_id)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Device already in use' }));
        ws.close(1008, 'Device already in use');
        return;
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
      console.log(`Client bridged to agent: ${msg.device_id}`);

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
        console.log(`Client disconnected from agent: ${msg.device_id}`);
      };

      ws.on('message', onClientMessage);
      agentWs.on('message', onAgentMessage);
      agentWs.on('close', onAgentClose);
      ws.on('close', onClientClose);

      if (agentWs.readyState === WebSocket.OPEN) {
        agentWs.send(JSON.stringify({ type: 'client_connected', user_email: user?.email ?? '' }));
      }
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

module.exports = { connectedAgents, sanitizeName, handleAgentConnection, handleClientConnection };
