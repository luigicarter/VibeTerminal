'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const TOML = require('@iarna/toml');
function privateRoute(home) {
  try {
    const route = TOML.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).openai_base_url;
    const url = new URL(route);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' ? route : null;
  } catch { return null; }
}

class Rpc extends EventEmitter {
  constructor(binary, home, cwd) {
    super(); this.pending = new Map(); this.serial = 0; this.buffer = ''; this.closed = false;
    const env = { ...process.env, CODEX_HOME: home };
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    const route = privateRoute(home);
    this.child = spawn(binary, ['app-server', '-c', 'cli_auth_credentials_store="file"', '-c', 'model_provider="openai"', ...(route ? ['-c', `openai_base_url=${JSON.stringify(route)}`] : [])], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    this.child.stdout.on('data', data => {
      this.buffer += decoder.write(data);
      if (this.buffer.length > 32 * 1024 * 1024) { this.close(); return; }
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method) this.emit('message', msg);
        else if (this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(entry.timer);
          if (msg.error) entry.reject(msg.error); else entry.resolve(msg.result);
        }
      }
    });
    // Drain stderr without persisting prompts, tool output or credentials.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => {});
    this.child.once('error', () => this.finish());
    this.child.once('exit', () => this.finish());
    this.ready = this.call('initialize', { clientInfo: { name: 'lina-codex-web', version: '0.1.0' }, capabilities: { experimentalApi: true } }).then(() => this.write({ method: 'initialized' }));
  }
  write(message) { if (this.closed || !this.child.stdin.writable) throw new Error('connection_failed'); this.child.stdin.write(JSON.stringify(message) + '\n'); }
  call(method, params, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('connection_failed')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  finish() {
    if (this.closed) return; this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('connection_failed')); }
    this.pending.clear(); this.emit('closed');
  }
  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && this.child.pid) {
          const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => resolve()); killer.once('exit', resolve);
        } else { this.child.kill('SIGKILL'); resolve(); }
      }, 2000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) throw new Error('connection_failed');
    this.finish();
  }
}

module.exports = { Rpc };
