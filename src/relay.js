const { getDeviceByCredential, consumeLinkToken, createDevice, updateLastSeen, listDevices } = require('./db');
const { verifySessionToken } = require('./auth');

const connectedAgents = new Map(); // deviceId -> ws

function handleAgentConnection(ws) {
  ws.once('message', (data) => {
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
      const device = getDeviceByCredential(msg.device_credential);
      if (!device) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid credential' }));
        ws.close(1008, 'Invalid credential');
        return;
      }
      updateLastSeen(device.id);
      connectedAgents.set(device.id, ws);
      console.log(`Agent connected: ${device.id} (${device.name})`);
      ws.send(JSON.stringify({ type: 'authenticated', device_id: device.id }));
      ws.on('close', () => {
        connectedAgents.delete(device.id);
        console.log(`Agent disconnected: ${device.id}`);
      });
    } else if (msg.device_token) {
      const userId = consumeLinkToken(msg.device_token);
      if (!userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired link token' }));
        ws.close(1008, 'Invalid link token');
        return;
      }
      const { id, device_credential } = createDevice(userId, msg.name || 'My Mac');
      console.log(`Agent registered new device: ${id}`);
      ws.send(JSON.stringify({ type: 'registered', device_credential, device_id: id }));
      updateLastSeen(id);
      connectedAgents.set(id, ws);
      ws.on('close', () => {
        connectedAgents.delete(id);
        console.log(`Agent disconnected: ${id}`);
      });
    } else {
      ws.close(1008, 'Missing device_credential or device_token');
    }
  });
}

function handleClientConnection(ws) {
  ws.once('message', (data) => {
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

    const devices = listDevices(userId);
    const device = devices.find((d) => d.id === msg.device_id);
    if (!device) {
      ws.send(JSON.stringify({ type: 'error', message: 'Device not found or not owned by user' }));
      ws.close(1008, 'Device not found');
      return;
    }

    const agentWs = connectedAgents.get(msg.device_id);
    if (!agentWs || agentWs.readyState !== 1 /* OPEN */) {
      ws.send(JSON.stringify({ type: 'error', message: 'Device offline' }));
      ws.close();
      return;
    }

    console.log(`Client bridged to agent: ${msg.device_id}`);

    const onAgentMessage = (chunk) => { if (ws.readyState === 1) ws.send(chunk); };
    const onAgentClose = () => { if (ws.readyState === 1) ws.close(); };

    ws.on('message', (chunk) => { if (agentWs.readyState === 1) agentWs.send(chunk); });
    agentWs.on('message', onAgentMessage);
    agentWs.on('close', onAgentClose);

    ws.on('close', () => {
      agentWs.removeListener('message', onAgentMessage);
      agentWs.removeListener('close', onAgentClose);
      console.log(`Client disconnected from agent: ${msg.device_id}`);
    });

    agentWs.send(JSON.stringify({ type: 'client_connected', user_email: email }));
  });
}

module.exports = { connectedAgents, handleAgentConnection, handleClientConnection };
