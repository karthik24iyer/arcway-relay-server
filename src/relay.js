const { getDeviceByCredential, updateLastSeen, listDevices } = require('./db');
const { verifySessionToken } = require('./auth');

const connectedAgents = new Map(); // deviceId -> ws

function sanitizeName(name) {
  return name.replace(/[^\x20-\x7E]/g, '').slice(0, 50) || 'My Mac';
}

function startHeartbeat(ws, deviceId) {
  let alive = true;
  ws.on('pong', () => {
    alive = true;
    updateLastSeen(deviceId).catch((err) => console.error(`updateLastSeen failed: ${deviceId}`, err));
  });
  const interval = setInterval(() => {
    if (!alive) {
      console.log(`Agent heartbeat timeout: ${deviceId}`);
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 5000);
  ws.on('close', () => clearInterval(interval));
}

function handleAgentConnection(ws) {
  const authTimeout = setTimeout(() => ws.close(1008, 'Auth timeout'), 10_000);
  ws.on('close', () => clearTimeout(authTimeout));
  ws.once('message', async (data) => {
    try {
      clearTimeout(authTimeout);
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        ws.close(1008, 'Invalid JSON');
        return;
      }

      if (msg.type !== 'auth') {
        ws.close(1008, 'Expected auth message');
        return;
      }

      if (msg.device_credential) {
        const device = await getDeviceByCredential(msg.device_credential);
        if (!device) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid credential' }));
          ws.close(1008, 'Invalid credential');
          return;
        }
        if (msg.name) device.name = sanitizeName(msg.name);
        await updateLastSeen(device.id);
        connectedAgents.set(device.id, ws);
        console.log(`Agent connected: ${device.id} (${device.name})`);
        ws.send(JSON.stringify({ type: 'authenticated', device_id: device.id }));
        startHeartbeat(ws, device.id);
        ws.on('close', () => {
          if (connectedAgents.get(device.id) === ws) {
            connectedAgents.delete(device.id);
            console.log(`Agent disconnected: ${device.id}`);
          }
        });
      } else {
        ws.close(1008, 'Missing device_credential');
      }
    } catch (err) {
      console.error('Agent auth error:', err);
      ws.close(1011, 'Internal error');
    }
  });
}

function handleClientConnection(ws) {
  const authTimeout = setTimeout(() => ws.close(1008, 'Auth timeout'), 10_000);
  ws.on('close', () => clearTimeout(authTimeout));
  ws.once('message', async (data) => {
    try {
      clearTimeout(authTimeout);
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        ws.close(1008, 'Invalid JSON');
        return;
      }

      if (msg.type !== 'auth') {
        ws.close(1008, 'Expected auth message');
        return;
      }

      let userId, email;
      try {
        ({ userId, email } = verifySessionToken(msg.session_token));
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

      const agentWs = connectedAgents.get(msg.device_id);
      if (!agentWs || agentWs.readyState !== 1 /* OPEN */) {
        ws.send(JSON.stringify({ type: 'error', message: 'Device offline' }));
        ws.close(1001, 'Device offline');
        return;
      }

      console.log(`Client bridged to agent: ${msg.device_id}`);

      const onAgentMessage = (chunk) => { if (ws.readyState === 1) ws.send(chunk); };
      const onAgentClose = () => { if (ws.readyState === 1) ws.close(1001, 'Agent disconnected'); };

      ws.on('message', (chunk) => { if (agentWs.readyState === 1) agentWs.send(chunk); });
      agentWs.on('message', onAgentMessage);
      agentWs.on('close', onAgentClose);

      ws.on('close', () => {
        agentWs.removeListener('message', onAgentMessage);
        agentWs.removeListener('close', onAgentClose);
        console.log(`Client disconnected from agent: ${msg.device_id}`);
      });

      agentWs.send(JSON.stringify({ type: 'client_connected', user_email: email }));
    } catch (err) {
      console.error('Client auth error:', err);
      ws.close(1011, 'Internal error');
    }
  });
}

module.exports = { connectedAgents, handleAgentConnection, handleClientConnection };
