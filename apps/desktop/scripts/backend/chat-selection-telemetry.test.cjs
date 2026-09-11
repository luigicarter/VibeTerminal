'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { createAgentTelemetryManager, notifyHookSource, codexLifecycleHookSource } = require('../../backend/agentTelemetry.cjs');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');

for (const [provider, engine] of [['claude', 'node'], ['codex', 'node'], ...(process.platform === 'win32' ? [['claude', 'powershell']] : [])]) {
  test(`${provider}/${engine}: generated selection hook through authenticated callback changes A to C`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-selection-hooks-'));
    const events = [], reads = [];
    const runtime = createTerminalRuntime({ lookup: async p => {
      reads.push(p);
      return { status: 'found', rootVerified: true, threadRef: { provider, id: p.confirmId } };
    } });
    const launch = runtime.beginLaunch({ id: 'pane', provider, cwd: root, launchToken: 1, threadRef: { provider, id: 'A' } });
    runtime.ingest({ id: 'pane', generation: launch.generation, type: 'created' });
    runtime.ingest({ id: 'pane', generation: launch.generation, type: 'agent-process', phase: 'start', processId: 'owner' });
    const manager = createAgentTelemetryManager({ baseDir: path.join(root, 'shims'), openCodeHome: path.join(root, 'opencode'),
      emit: e => { events.push(e); runtime.ingest(e); } });
    t.after(() => {
      manager.cleanup(); runtime.dispose();
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('lina-selection-hooks-'));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const prepared = await manager.prepareSession('pane', { provider, generation: launch.generation });
    const observer = path.join(root, 'observer.cjs');
    fs.writeFileSync(observer, provider === 'claude' ? notifyHookSource() : codexLifecycleHookSource());
    async function hook(id, fields = {}, invocationId = 'owner') {
      const args = engine === 'powershell' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(manager.runDir, 'notify.ps1'), 'agent.session'] :
        [observer, ...(provider === 'claude' ? ['agent.session'] : [])];
      const child = spawn(engine === 'powershell' ? 'powershell.exe' : process.execPath, args,
        { env: { ...process.env, ...prepared.env, VIBE_TERMINAL_INVOCATION_ID: invocationId }, windowsHide: true });
      let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
      const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      child.stdin.end(JSON.stringify({ session_id: id, hook_event_name: 'SessionStart', source: 'clear',
        transcript_path: path.join(root, `${id}.jsonl`), prompt: 'PRIVATE_PROMPT', ...fields }));
      assert.equal(await done, 0); assert.equal(output, '');
      await runtime.refresh();
    }
    await hook('B'); await hook('C');
    assert.equal(runtime.getSnapshot('pane').conversation.id, 'C');
    assert.deepEqual(reads.map(p => p.confirmId), ['B', 'C']);
    assert.ok(events.every(e => e.generation === launch.generation));
    assert.ok(events.every(e => e.invocationId === 'owner'));
    assert.ok(!JSON.stringify(events).includes('PRIVATE_PROMPT'));
    await hook('nested', {}, 'nested-owner');
    await hook('child', { parent_session_id: 'C' });
    await hook('fork', { source: 'fork' });
    assert.equal(runtime.getSnapshot('pane').conversation.id, 'C');
  });
}
