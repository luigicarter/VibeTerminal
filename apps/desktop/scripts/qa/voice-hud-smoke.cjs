'use strict';
// Isolated real Electron renderer with synthetic voice states and visibility.
// No microphone, provider, application backend, or installed user profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function verify(output) {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(output, 'userData'));
  await app.whenReady();
  const win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, partition: 'voice-hud-qa' } });
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith('file:') }));
  const evaluate = expression => win.webContents.executeJavaScript(expression);
  const report = { pass: false, boundary: 'Isolated component renderer; synthetic voice states and visibility; no physical audio or installed-app verification.', checks: [], screenshots: [] };
  async function state(next) {
    await evaluate(`window.__hudQA.setState(${JSON.stringify(next)})`);
    await wait(250);
  }
  async function snapshot() {
    return evaluate(`(() => {
      const host = document.querySelector('.voice-indicator'), mic = host.querySelector('.voice-mic');
      const style = getComputedStyle(mic), rect = mic.getBoundingClientRect(), outer = host.getBoundingClientRect();
      return { classes: host.className, opacity: Number(style.opacity), transform: style.transform, shadow: style.boxShadow,
        width: rect.width, height: rect.height, inBounds: outer.left >= 0 && outer.top >= 0 && outer.right <= innerWidth && outer.bottom <= innerHeight,
        animations: mic.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSAnimation).map(animation => animation.animationName),
        transitions: mic.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSTransition).map(animation => ({ property: animation.transitionProperty, state: animation.playState })),
        icon: mic.querySelector('svg').getAttribute('class'), hudPointerEvents: getComputedStyle(host.querySelector('.voice-hud')).pointerEvents };
    })()`);
  }
  try {
    await win.loadFile(path.join(output, 'fixture.html'));
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) { ready = await evaluate('Boolean(window.__hudQA?.ready)'); if (!ready) await wait(50); }
    assert(ready, 'React voice indicator mounted');
    win.webContents.debugger.attach('1.3');
    const media = features => win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features });
    const cases = [
      ['idle', { phase: 'listening', listening: true }, 'listening', 'lucide-mic', .55, 0],
      ['awaiting-answer', { phase: 'awaiting-answer', listening: true }, 'listening', 'lucide-mic', .55, 0],
      ['recording', { phase: 'recording', listening: true, recordingSource: 'ptt', recordingId: 1 }, 'recording', 'lucide-mic', .8, 4],
      ['automatic', { phase: 'recording', listening: true, recordingSource: 'wake', recordingId: 2 }, 'recording', 'lucide-send', .8, 4],
      ['thinking', { phase: 'thinking', listening: true }, 'thinking', 'lucide-square', .8, 1],
      ['speaking', { phase: 'speaking', listening: true }, 'speaking', 'lucide-mic', .8, 1],
      ['muted', { phase: 'off', listening: false }, 'muted', 'lucide-mic-off', .55, 0],
      ['error', { phase: 'microphone-error', listening: false }, 'error', 'lucide-mic-off', .88, 0],
    ];
    for (const [width, height] of [[1280, 800], [360, 640]]) {
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      for (const [name, next, visual, icon, opacity, animations] of cases) {
        await state(next);
        const actual = await snapshot();
        assert(actual.classes.split(' ').includes(`voice-${visual}`), name);
        assert(actual.icon.split(' ').includes(icon), name);
        assert.equal(actual.opacity, opacity, `${name} opacity`);
        assert.equal(actual.width, 58); assert.equal(actual.height, 58);
        assert.equal(actual.transform, 'none', 'The control never scales or rotates');
        assert.equal(actual.shadow, 'none', 'No bloom');
        assert.equal(actual.hudPointerEvents, 'none'); assert(actual.inBounds);
        assert.equal(actual.animations.length, animations, `${name} keyframe animation count: ${JSON.stringify(actual)}`);
        const image = await win.webContents.capturePage({ x: width - 160, y: height - 160, width: 160, height: 160 });
        const pixels = image.getBitmap(); let lit = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 70 || pixels[i + 1] > 70 || pixels[i + 2] > 70) lit++;
        assert(lit > 20, `${name} must produce visible icon pixels`);
        const filename = `${width}-${name}.png`;
        fs.writeFileSync(path.join(output, filename), image.toPNG());
        report.screenshots.push(filename); report.checks.push({ viewport: width, state: name, ...actual });
      }
    }
    await state({ phase: 'listening', listening: true });
    await evaluate("document.querySelector('.voice-mic').focus()"); await wait(250);
    assert.equal((await snapshot()).opacity, .95, 'Keyboard focus raises contrast');
    await evaluate('document.activeElement.blur()'); await wait(250);
    await state({ phase: 'thinking', listening: true });
    const transform = () => evaluate("getComputedStyle(document.querySelector('.voice-hud-scan')).transform");
    const before = await transform(); await wait(350); assert.notEqual(await transform(), before, 'Processing arc actually moves');
    await media([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    for (const phase of ['recording', 'thinking', 'speaking']) { await state({ phase, listening: true }); assert.equal((await snapshot()).animations.length, 0, `${phase} respects reduced motion`); }
    await media([{ name: 'prefers-contrast', value: 'more' }]);
    for (const phase of ['listening', 'recording', 'thinking', 'speaking', 'microphone-error']) { await state({ phase, listening: true }); assert.equal((await snapshot()).opacity, 1, `${phase} respects high contrast`); }
    await media([]); await state({ phase: 'thinking', listening: true });
    await evaluate('window.__hudQA.setHidden(true)'); await wait(250);
    assert.equal((await snapshot()).animations.length, 0, 'Hidden state suppresses animation');
    await evaluate('window.__hudQA.setHidden(false)'); await wait(250);
    assert.equal((await snapshot()).animations.length, 1, 'Visible processing resumes its arc');
    report.checks.push({ focusContrast: true, processingMotion: true, reducedMotion: true, highContrast: true, hiddenAnimationSuppression: true });
    report.pass = true;
    console.log('Voice HUD renderer checks passed: 16 viewport/state combinations, visible pixels, fixed geometry, state icons, opacity, keyboard focus, animation, reduced motion, high contrast, and hidden visibility.');
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
    win.destroy();
  }
}

if (process.argv.includes('--voice-hud-child')) {
  verify(process.argv[process.argv.indexOf('--voice-hud-child') + 1]).then(() => require('electron').app.exit(0), error => { console.error(error); require('electron').app.exit(1); });
} else {
  const output = path.join(root, '.tmp', 'voice-hud-smoke', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(output, { recursive: true });
  const { buildSync } = require(require.resolve('esbuild', { paths: [path.dirname(require.resolve('vite'))] }));
  buildSync({ absWorkingDir: root, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, outfile: path.join(output, 'fixture.js'), stdin: { resolveDir: root, sourcefile: 'voice-hud-fixture.tsx', loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import VoiceIndicator from './frontend/VoiceIndicator';
    let current = { phase: 'off', listening: false, indicatorVisible: true }, hidden = false;
    const listeners = new Set();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    window.__hudQA = {
      ready: false,
      setState(next) { current = { ready: true, muted: !next.listening, ...next, indicatorVisible: true }; listeners.forEach(listener => listener(current)); },
      setHidden(next) { hidden = next; document.dispatchEvent(new Event('visibilitychange')); }
    };
    window.vibe = { voice: {
      getState: async () => current,
      onState(listener) { listeners.add(listener); window.__hudQA.ready = true; return () => listeners.delete(listener); },
      configure: async () => ({ ok: true }), cancelSpeech: async () => ({ ok: true }), setListening: async () => ({ ok: true })
    } };
    createRoot(document.getElementById('root')).render(<VoiceIndicator />);
  ` } });
  fs.writeFileSync(path.join(output, 'fixture.html'), '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="fixture.css"><style>html,body{margin:0;width:100%;height:100%;background:#121418}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, '--voice-hud-child', output], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  console.log(`Artifacts: ${output}`);
  if (child.error) console.error(child.error);
  process.exitCode = child.status === 0 && !child.error ? 0 : 1;
}
