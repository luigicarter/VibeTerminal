'use strict';
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');

async function secretPrompt(label, { input = process.stdin, output = process.stdout } = {}) {
  // readline handles editing and restores terminal mode, but its output is
  // suppressed so the runtime key never enters terminal scrollback.
  output.write(label);
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const controller = new AbortController();
  const rl = readline.createInterface({ input, output: silent, terminal: input.isTTY === true });
  rl.once('SIGINT', () => controller.abort());
  try { return await rl.question('', { signal: controller.signal }); }
  finally { rl.close(); input.pause(); silent.end(); output.write('\n'); }
}

async function setupTools({ call, prompt, secret = secretPrompt, print = console.log }) {
  await call('setup-consume');
  let state = (await call('terminal-status')).state;
  print('\nCodex Web · local tools setup');
  print('ChatGPT needs an OpenAI tunnel and connector to reach this terminal’s tools.');
  let replace = !state.connection.toolsCredentials;
  if (!replace) {
    const choice = (await prompt('Enter to reuse the saved connection · r to replace · q to return: ')).trim().toLowerCase();
    if (choice === 'q') return;
    replace = choice === 'r';
  }
  if (replace) {
    print('Use the same OpenAI account as your Codex Web login.');
    if ((await prompt('Enter to open tunnel settings in your browser · q to return: ')).trim().toLowerCase() === 'q') return;
    await call('setup-browser', { page: 'tunnels' });
    const tunnelId = (await prompt('Create a tunnel there, then paste its Tunnel ID here (blank to cancel): ')).trim();
    if (!tunnelId) return;
    if (!/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) throw new Error('The Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters.');
    print('Create an API key with Tunnels Read + Use permission. Lina stores it in Codex Web’s private app data.');
    await call('setup-browser', { page: 'keys' });
    const runtimeKey = (await secret('Paste the tunnel runtime key (hidden; blank to cancel): ')).trim();
    if (!runtimeKey) return;
    if (runtimeKey.length < 20 || runtimeKey.length > 4096) throw new Error('The tunnel runtime key is incomplete.');
    print('Connecting local tools…');
    state = (await call('setup-tools', { tunnelId, runtimeKey, replace: true })).state;
  } else {
    print('Reconnecting saved local tools…');
    state = (await call('setup-tools', { replace: false })).state;
  }
  const connector = state.connection.connectorName || 'Codex Native2';
  print(`In ChatGPT, enable Developer Mode and create a connector named exactly "${connector}".`);
  print('Choose Tunnel, select this tunnel, set Authentication to None, and allow all actions. Codex still handles local approvals.');
  const choice = (await prompt('Enter to open ChatGPT connector settings · v to verify an existing connector · q to return: ')).trim().toLowerCase();
  if (choice === 'q') return;
  if (choice !== 'v') {
    await call('setup-browser', { page: 'connector' });
    if ((await prompt('Finish the connector in your browser, then press Enter to verify · q to return: ')).trim().toLowerCase() === 'q') return;
  }
  print('Checking the local runtime and ChatGPT connector…');
  await call('verify-tools');
  print('Local tools connected.');
}
module.exports = { setupTools, secretPrompt };
