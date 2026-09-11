'use strict';
// Electron's app process does not expose Node's fork IPC consistently. Use an
// authenticated, owner-created local pipe for the small control protocol instead.
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
function read(socket, key, receive) {
  let buffer = ''; const decoder = new StringDecoder('utf8');
  socket.on('data', data => {
    buffer += decoder.write(data);
    if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const packet = JSON.parse(line);
        if (typeof packet.key !== 'string' || packet.key.length !== key.length || !crypto.timingSafeEqual(Buffer.from(packet.key), Buffer.from(key))) { socket.destroy(); return; }
        receive(packet.message);
      } catch { socket.destroy(); return; }
    }
  });
  socket.on('error', () => {});
}
async function spawnBridge(executable, args, options) {
  const key = crypto.randomBytes(32).toString('hex');
  const name = 'lina-codex-web-' + crypto.randomUUID();
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : path.join(os.tmpdir(), name + '.sock');
  let channel = null, child;
  const server = net.createServer(socket => {
    read(socket, key, message => {
      if (!channel) { channel = socket; child.connected = true; }
      if (channel !== socket) { socket.destroy(); return; }
      child.emit('message', message);
    });
    socket.on('close', () => { if (channel === socket && child) { child.connected = false; child.emit('disconnect'); } });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  child = spawn(executable, args, { ...options, env: { ...options.env, LINA_CODEX_WEB_PIPE: pipe, LINA_CODEX_WEB_CHANNEL_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.connected = false;
  child.send = (message, callback) => {
    if (!channel || channel.destroyed) { callback?.(new Error('connection_failed')); return false; }
    channel.write(JSON.stringify({ key, message }) + '\n', callback); return true;
  };
  child.disconnect = () => { channel?.destroy(); child.connected = false; };
  const cleanup = () => { channel?.destroy(); server.close(); };
  child.once('error', cleanup); child.once('exit', cleanup);
  return child;
}
function attachBridgeChannel() {
  const pipe = process.env.LINA_CODEX_WEB_PIPE, key = process.env.LINA_CODEX_WEB_CHANNEL_KEY;
  if (!pipe || !/^[a-f0-9]{64}$/.test(key || '')) throw new Error('Codex Web must be launched by Lina.');
  const socket = net.createConnection(pipe);
  Object.defineProperty(process, 'connected', { configurable: true, get: () => !socket.destroyed });
  process.send = message => socket.write(JSON.stringify({ key, message }) + '\n');
  read(socket, key, message => process.emit('message', message));
  socket.once('close', () => process.emit('disconnect'));
}
module.exports = { spawnBridge, attachBridgeChannel };
