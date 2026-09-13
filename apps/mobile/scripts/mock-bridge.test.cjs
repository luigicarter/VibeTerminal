'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const path = require('node:path');

const {
  anchorPan,
  clampPan,
  createMockBridge,
  fitFontSize,
  fitScale,
  renderRow,
  resolveXtermAssets,
  DEFAULT_CODE,
  DEFAULT_PORT,
  FRAME_FPS,
  MAX_FONT_SIZE,
  SCROLLBACK_LIMIT,
  STREAM_PROTOCOL,
  TRANSCRIPT_LIMIT,
} = require('./mock-bridge.cjs');
const { READ_ONLY_NOTE, isReadOnlyRejection } = require('../src/api/readOnly.js');
const { TERMINAL_KEYS, controlCode } = require('../src/api/keys.js');
const {
  countsWithNeedsInput,
  normalizeNeedsInput,
  promptLine,
  sessionNeedsInput,
  waitingForYou,
} = require('../src/state/needsInput.js');
const {
  FRESH_WINDOW_MS,
  TONE_LABELS,
  connectionTone,
  orchestratorSubtitle,
} = require('../src/state/presence.js');
const {
  ANDROID_HOST_ALIAS,
  hostFromHostUri,
  seedCandidates,
  subnetCandidates,
  subnetLabel,
} = require('../src/state/candidates.js');

const AUTH = `Bearer ${DEFAULT_CODE.replace(/-/g, '')}`;

/** Boot a bridge on an ephemeral port and always close it again. */
async function withBridge(options, body) {
  const bridge = createMockBridge({
    tickMs: 0,
    requestFinishMs: 0,
    replyMs: 0,
    mutateMs: 0,
    ...options,
  });
  await bridge.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${bridge.port}`;
  try {
    return await body(bridge, base);
  } finally {
    await bridge.close();
  }
}

function get(base, path, init = {}) {
  return fetch(`${base}${path}`, { headers: { Authorization: AUTH }, ...init });
}

function post(base, path, payload) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

test('the mock stays off the desktop bridge port', () => {
  assert.equal(DEFAULT_PORT, 47832);
});

test('hello identifies the desktop when the code matches', async () => {
  await withBridge({}, async (bridge, base) => {
    const response = await get(base, '/api/hello');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.app, 'lina-terminal');
    assert.equal(body.bridge, 1);
    assert.equal(body.readOnly, false);
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.host, 'string');
  });
});

test('a wrong pairing code is refused with 401', async () => {
  await withBridge({}, async (bridge, base) => {
    const response = await fetch(`${base}/api/hello`, { headers: { Authorization: 'Bearer NOPE' } });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(typeof body.error, 'string');

    const missing = await fetch(`${base}/api/hello`);
    assert.equal(missing.status, 401);
  });
});

test('the code is compared without dashes and without case', async () => {
  await withBridge({}, async (bridge, base) => {
    const response = await fetch(`${base}/api/hello`, {
      headers: { Authorization: `Bearer ${DEFAULT_CODE}` },
    });
    assert.equal(response.status, 200);
  });
});

test('state carries the projects, sessions and orchestrator summary', async () => {
  await withBridge({}, async (bridge, base) => {
    const response = await get(base, '/api/state?revision=0&wait=0');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const body = await response.json();

    assert.equal(body.ok, true);
    assert.equal(typeof body.revision, 'number');
    assert.equal(body.projects.length, 3);
    assert.deepEqual(
      body.projects.map(project => project.name),
      ['vibeTerminal', 'lina-site', 'notes']
    );
    for (const project of body.projects) {
      assert.deepEqual(Object.keys(project.counts).sort(), ['done', 'failed', 'waiting', 'working']);
    }

    assert.equal(body.sessions.length, 7);
    const kinds = body.sessions.map(session => session.kind);
    assert.deepEqual(kinds, ['codex', 'claude', 'gemini', 'terminal', 'fusion', 'qwen', 'cursor']);
    assert.deepEqual(
      body.sessions.map(session => session.status),
      ['working', 'waiting', 'done', 'idle', 'working', 'failed', 'exited']
    );
    for (const session of body.sessions) {
      for (const field of [
        'id',
        'generation',
        'projectId',
        'projectName',
        'title',
        'kind',
        'provider',
        'isChat',
        'status',
        'lastActivityAt',
        'attention',
        'snippet',
        'needsInput',
      ]) {
        assert.ok(field in session, `session ${session.id} is missing ${field}`);
      }
    }

    assert.equal(body.orchestrator.enabled, true);
    assert.equal(body.orchestrator.ready, true);
    assert.equal(typeof body.orchestrator.activeCount, 'number');

    const vibe = body.projects.find(project => project.name === 'vibeTerminal');
    assert.equal(vibe.counts.working, 1);
    assert.equal(vibe.counts.waiting, 1);
  });
});

test('state leaves out what the phone can work out for itself', async () => {
  await withBridge({}, async (bridge, base) => {
    const body = await (await get(base, '/api/state?revision=0&wait=0')).json();
    const byId = new Map(body.sessions.map(session => [session.id, session]));
    const vibe = body.projects.find(project => project.id === 'p-vibe');

    // A label that would only repeat the status is not sent at all…
    assert.equal('statusLabel' in byId.get('s-codex'), false);
    assert.equal('statusLabel' in byId.get('s-claude'), false);
    // …and one that says something the status cannot is.
    assert.equal(byId.get('s-fusion').statusLabel, 'Working · milestone 3 of 3');
    assert.equal(byId.get('s-qwen').statusLabel, 'Failed · ENOENT');

    // Same for a working directory that is only the project's own path.
    assert.equal('cwd' in byId.get('s-codex'), false);
    assert.equal(byId.get('s-terminal').cwd, `${vibe.path}\\apps\\desktop`);

    // And no snippet is longer than a row can show.
    for (const session of body.sessions) {
      assert.ok(session.snippet.length <= 80, `${session.id} snippet is ${session.snippet.length} long`);
    }
  });
});

test('a long poll parks on a matching revision and wakes on the status flip', async () => {
  await withBridge({}, async (bridge, base) => {
    const first = await (await get(base, '/api/state?revision=0&wait=0')).json();
    const startedAt = Date.now();
    const pending = get(base, `/api/state?revision=${first.revision}&wait=3000`);

    // Give the request time to park before changing anything.
    await new Promise(resolve => setTimeout(resolve, 150));
    bridge.tick();

    const body = await (await pending).json();
    const elapsed = Date.now() - startedAt;
    assert.ok(body.revision > first.revision, 'the revision must move when a session flips');
    assert.ok(elapsed < 2500, `the poll should wake early, took ${elapsed}ms`);

    const changed = body.sessions.find(session => session.id === 's-claude');
    assert.equal(changed.status, 'working');
  });
});

test('a long poll returns at once when the client revision is stale', async () => {
  await withBridge({}, async (bridge, base) => {
    const startedAt = Date.now();
    const body = await (await get(base, '/api/state?revision=999&wait=5000')).json();
    assert.equal(body.ok, true);
    assert.ok(Date.now() - startedAt < 1000, 'a stale revision must not park');
  });
});

test('JSON worth compressing is gzipped, and survives the round trip', async () => {
  await withBridge({}, async (bridge, base) => {
    const port = bridge.port;
    const raw = (path, headers) =>
      new Promise((resolve, reject) => {
        const request = http.request(
          { host: '127.0.0.1', port, path, headers: { Authorization: AUTH, ...headers } },
          response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () =>
              resolve({ headers: response.headers, body: Buffer.concat(chunks) })
            );
          }
        );
        request.on('error', reject);
        request.end();
      });

    const compressed = await raw('/api/state?revision=0&wait=0', { 'Accept-Encoding': 'gzip' });
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.match(compressed.headers.vary || '', /Accept-Encoding/i);
    const unzipped = JSON.parse(zlib.gunzipSync(compressed.body).toString('utf8'));
    assert.equal(unzipped.ok, true);
    assert.equal(unzipped.sessions.length, 7);

    // A client that cannot take gzip gets exactly the same JSON, uncompressed…
    const plain = await raw('/api/state?revision=0&wait=0', { 'Accept-Encoding': 'identity' });
    assert.equal(plain.headers['content-encoding'], undefined);
    const parsed = JSON.parse(plain.body.toString('utf8'));
    assert.deepEqual(parsed.sessions, unzipped.sessions);
    assert.ok(
      compressed.body.length < plain.body.length / 2,
      `gzip saved nothing: ${compressed.body.length} vs ${plain.body.length}`
    );

    // …and a body too small to be worth a gzip header is left alone.
    const small = await raw('/api/sessions/nope/transcript', { 'Accept-Encoding': 'gzip' });
    assert.equal(small.headers['content-encoding'], undefined);
  });
});

test('screen and transcript answer per session', async () => {
  await withBridge({}, async (bridge, base) => {
    const screen = await (await get(base, '/api/sessions/s-codex/screen?maxChars=12000')).json();
    assert.equal(screen.ok, true);
    assert.equal(screen.exited, false);
    assert.ok(screen.text.includes('npm run smoke:backend:phone-bridge'));

    const exited = await (await get(base, '/api/sessions/s-cursor/screen')).json();
    assert.equal(exited.exited, true);

    const transcript = await (await get(base, '/api/sessions/s-claude/transcript')).json();
    assert.equal(transcript.status, 'found');
    assert.ok(transcript.messages.length >= 5);
    assert.deepEqual(
      [...new Set(transcript.messages.map(message => message.role))].sort(),
      ['assistant', 'user']
    );

    const unsupported = await (await get(base, '/api/sessions/s-terminal/transcript')).json();
    assert.equal(unsupported.status, 'unsupported');
    assert.deepEqual(unsupported.messages, []);
    assert.equal(unsupported.total, 0);
    assert.equal(unsupported.nextBefore, null);

    const missing = await get(base, '/api/sessions/nope/screen');
    assert.equal(missing.status, 404);
  });
});

test('the transcript is paged backwards until there is nothing earlier', async () => {
  await withBridge({}, async (bridge, base) => {
    const whole = await (await get(base, '/api/sessions/s-codex/transcript?limit=200')).json();
    assert.equal(whole.total, whole.messages.length);
    assert.equal(whole.nextBefore, null, 'one page that holds everything has nothing before it');

    // The default page is the newest end of the conversation.
    const first = await (await get(base, '/api/sessions/s-codex/transcript?limit=3')).json();
    assert.equal(first.messages.length, 3);
    assert.equal(first.total, whole.total);
    assert.equal(first.nextBefore, whole.total - 3);
    assert.deepEqual(first.messages, whole.messages.slice(-3));

    // Walking `before` back reassembles the transcript exactly, and stops.
    let collected = first.messages;
    let before = first.nextBefore;
    let pages = 1;
    while (before !== null) {
      const page = await (await get(
        base,
        `/api/sessions/s-codex/transcript?limit=3&before=${before}`
      )).json();
      assert.ok(page.messages.length > 0, 'a page with something before it cannot be empty');
      collected = page.messages.concat(collected);
      before = page.nextBefore;
      pages += 1;
      assert.ok(pages < 20, 'paging must terminate');
    }
    assert.deepEqual(collected, whole.messages);
    assert.equal(pages, Math.ceil(whole.total / 3));

    // The size is clamped, and the default is one screenful.
    const clamped = await (await get(base, '/api/sessions/s-codex/transcript?limit=9999')).json();
    assert.equal(clamped.messages.length, whole.total);
    assert.equal(TRANSCRIPT_LIMIT, 50);
  });
});

test('input lands in the screen and the transcript', async () => {
  await withBridge({}, async (bridge, base) => {
    const sent = 'run the smoke test again';
    const response = await post(base, '/api/sessions/s-codex/input', { text: sent });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.actionId, 'string');

    const screen = await (await get(base, '/api/sessions/s-codex/screen')).json();
    assert.ok(screen.text.includes(sent), 'the screen must echo the input');

    const transcript = await (await get(base, '/api/sessions/s-codex/transcript')).json();
    const last = transcript.messages[transcript.messages.length - 1];
    assert.equal(last.role, 'user');
    assert.equal(last.text, sent);

    const state = await (await get(base, '/api/state?revision=0&wait=0')).json();
    const session = state.sessions.find(entry => entry.id === 's-codex');
    assert.equal(session.status, 'working');
  });
});

test('input to an exited terminal is refused with 409', async () => {
  await withBridge({}, async (bridge, base) => {
    const response = await post(base, '/api/sessions/s-cursor/input', { text: 'hello' });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.ok, false);
  });
});

test('empty input is refused with 400', async () => {
  await withBridge({}, async (bridge, base) => {
    const response = await post(base, '/api/sessions/s-codex/input', { text: '   ' });
    assert.equal(response.status, 400);
  });
});

test('interrupt moves the terminal back to waiting', async () => {
  await withBridge({}, async (bridge, base) => {
    const response = await post(base, '/api/sessions/s-fusion/interrupt');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.actionId, 'string');

    const state = await (await get(base, '/api/state?revision=0&wait=0')).json();
    const session = state.sessions.find(entry => entry.id === 's-fusion');
    assert.equal(session.status, 'waiting');
  });
});

test('orchestrator history carries messages and tasks', async () => {
  await withBridge({}, async (bridge, base) => {
    const body = await (await get(base, '/api/orchestrator/history?limit=200')).json();
    assert.equal(body.ok, true);
    assert.equal(body.enabled, true);
    assert.equal(body.ready, true);
    assert.equal(body.messages.length, 6);
    assert.equal(body.tasks.length, 3);
    assert.deepEqual(
      body.tasks.map(task => task.status),
      ['running', 'finished', 'needs-answer']
    );
    for (const message of body.messages) {
      assert.ok(['user', 'assistant', 'system'].includes(message.role));
      assert.equal(typeof message.text, 'string');
    }
  });
});

test('an orchestrator request queues a task and finishes it', async () => {
  await withBridge({ requestFinishMs: 120 }, async (bridge, base) => {
    const text = 'check the phone bridge tests';
    const response = await post(base, '/api/orchestrator/request', { text });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.requestId, 'string');
    assert.equal(body.status, 'queued');

    const queued = await (await get(base, '/api/orchestrator/history')).json();
    const task = queued.tasks.find(entry => entry.requestId === body.requestId);
    assert.ok(task, 'the request must create a task');
    assert.equal(task.status, 'queued');
    assert.ok(queued.messages.some(message => message.role === 'user' && message.text === text));

    await new Promise(resolve => setTimeout(resolve, 400));

    const finished = await (await get(base, '/api/orchestrator/history')).json();
    const done = finished.tasks.find(entry => entry.id === task.id);
    assert.equal(done.status, 'finished');
    assert.equal(typeof done.result, 'string');
    assert.ok(
      finished.messages.some(message => message.role === 'assistant' && message.text.includes(text)),
      'the Orchestrator must reply when the task finishes'
    );
  });
});

test('a preflight request is answered without a code', async () => {
  await withBridge({}, async (bridge, base) => {
    const response = await fetch(`${base}/api/state`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-allow-headers') || '', /Authorization/i);
  });
});

test('an unknown endpoint answers 404 in the error shape', async () => {
  await withBridge({}, async (bridge, base) => {
    const response = await get(base, '/api/nope');
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'not found');
  });
});

test('an unknown session answers exactly "not found"', async () => {
  await withBridge({}, async (bridge, base) => {
    const body = await (await get(base, '/api/sessions/nope/transcript')).json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'not found');
  });
});

test('read-only mode reports the flag and refuses every write route with 404', async () => {
  await withBridge({ readOnly: true }, async (bridge, base) => {
    const hello = await (await get(base, '/api/hello')).json();
    assert.equal(hello.readOnly, true);

    // Reading is untouched.
    const state = await (await get(base, '/api/state?revision=0&wait=0')).json();
    assert.equal(state.sessions.length, 7);
    const screen = await (await get(base, '/api/sessions/s-codex/screen')).json();
    assert.equal(screen.ok, true);

    for (const [path, payload] of [
      ['/api/sessions/s-codex/input', { text: 'hello' }],
      ['/api/sessions/s-codex/interrupt', undefined],
      ['/api/orchestrator/request', { text: 'do something' }],
    ]) {
      const response = await post(base, path, payload);
      assert.equal(response.status, 404, `${path} must answer 404 in read-only mode`);
      const body = await response.json();
      assert.deepEqual(body, { ok: false, error: 'not found' });
    }

    // Nothing was written.
    const after = await (await get(base, '/api/orchestrator/history')).json();
    assert.equal(after.tasks.length, 3);
    assert.equal(after.messages.length, 6);
  });
});

test('a 403 or 404 from a write route maps to the read-only state, and nothing else does', () => {
  const notFound = { bridgeError: true, kind: 'notFound', status: 404 };
  const forbidden = { bridgeError: true, kind: 'forbidden', status: 403 };
  for (const route of ['input', 'keys', 'interrupt', 'orchestrator-request']) {
    assert.equal(isReadOnlyRejection(notFound, route), true, `404 on ${route}`);
    assert.equal(isReadOnlyRejection(forbidden, route), true, `403 on ${route}`);
  }

  // A read route's 404 means the terminal is gone, not that the desktop is read-only.
  assert.equal(isReadOnlyRejection(notFound, 'screen'), false);
  assert.equal(isReadOnlyRejection(notFound, 'transcript'), false);
  assert.equal(isReadOnlyRejection(notFound, 'state'), false);
  assert.equal(isReadOnlyRejection(forbidden, 'stream'), false);

  // Other failures on a write route stay what they are.
  assert.equal(isReadOnlyRejection({ bridgeError: true, kind: 'conflict', status: 409 }, 'input'), false);
  assert.equal(isReadOnlyRejection({ bridgeError: true, kind: 'unavailable', status: 503 }, 'orchestrator-request'), false);
  assert.equal(isReadOnlyRejection({ bridgeError: true, kind: 'network' }, 'input'), false);
  assert.equal(isReadOnlyRejection(null, 'input'), false);
  assert.equal(isReadOnlyRejection(new Error('boom'), 'input'), false);

  assert.equal(
    READ_ONLY_NOTE,
    'This desktop build only shows your terminals. Typing from the phone is not enabled yet.'
  );
});

test('the connection tone claims nothing before the first poll', () => {
  const now = 1_000_000;
  const fresh = now - 1000;

  // Nothing has failed yet: neutral, never red.
  assert.equal(connectionTone('idle', null, { now }), 'connecting');
  assert.equal(connectionTone('connecting', null, { now }), 'connecting');
  assert.equal(TONE_LABELS.connecting, 'connecting…');

  // A stopped loop is not a fault.
  assert.equal(connectionTone('online', fresh, { now, appActive: false }), 'paused');
  assert.equal(connectionTone('offline', null, { now, appActive: false }), 'paused');
  assert.equal(TONE_LABELS.paused, 'paused');

  // The three real states keep their meaning.
  assert.equal(connectionTone('online', fresh, { now }), 'connected');
  assert.equal(connectionTone('online', now - FRESH_WINDOW_MS - 1, { now }), 'reconnecting');
  assert.equal(connectionTone('reconnecting', fresh, { now }), 'reconnecting');
  assert.equal(connectionTone('offline', fresh, { now }), 'failed');
  assert.equal(TONE_LABELS.failed, 'not connected');
  assert.equal(TONE_LABELS.connected, 'connected');
});

test('the Ask Lina subtitle only says "off" once the desktop has said so', () => {
  assert.equal(orchestratorSubtitle(null), 'Orchestrator');
  assert.equal(orchestratorSubtitle(undefined), 'Orchestrator');
  assert.equal(orchestratorSubtitle({ enabled: false, ready: false }), 'Orchestrator · off');
  assert.equal(orchestratorSubtitle({ enabled: true, ready: true }), 'Orchestrator · ready');
  assert.equal(orchestratorSubtitle({ enabled: true, ready: false }), 'Orchestrator · starting…');
});

// --- the live terminal, protocol 2 -------------------------------------------

const CODE = DEFAULT_CODE.replace(/-/g, '');
test('mock terminal assets come from the mobile app installation', () => {
  const assets = resolveXtermAssets(null);
  assert.ok(assets, 'run npm ci in apps/mobile');
  assert.equal(assets.from, path.resolve(__dirname, '..'));
});

/**
 * Read a server-sent event stream until it has `events` of them, the server
 * ends it, or the deadline passes — whichever comes first. `fetch` decodes the
 * gzip the mock sends, so nothing here has to know about it.
 */
async function readStream(base, path, options = {}) {
  const { events = 3, timeoutMs = 4000, headers, until } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(`${base}${path}`, { headers, signal: controller.signal });
  if (!response.ok) {
    clearTimeout(timer);
    controller.abort();
    return { status: response.status, events: [], ended: true, seconds: 0 };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const collected = [];
  const startedAt = Date.now();
  let buffer = '';
  let ended = false;
  try {
    while (collected.length < events) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const name = /^event: (.+)$/m.exec(block);
        const data = /^data: (.+)$/m.exec(block);
        if (name) collected.push({ event: name[1], data: data ? JSON.parse(data[1]) : null });
        index = buffer.indexOf('\n\n');
      }
      if (until && until(collected)) break;
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return {
    status: response.status,
    events: collected,
    ended,
    seconds: (Date.now() - startedAt) / 1000,
  };
}

test('the stream opens with hello, the scrollback and one full screen', async () => {
  await withBridge({}, async (bridge, base) => {
    const { status, events } = await readStream(base, `/api/sessions/s-codex/stream?code=${CODE}`);

    assert.equal(status, 200);
    assert.deepEqual(
      events.map(entry => entry.event),
      ['hello', 'scrollback', 'screen']
    );

    const hello = events[0].data;
    assert.deepEqual(Object.keys(hello).sort(), ['cols', 'control', 'exited', 'protocol', 'rows', 'seq']);
    assert.equal(hello.protocol, STREAM_PROTOCOL);
    assert.equal(hello.cols, 80);
    assert.equal(hello.rows, 24);
    assert.equal(hello.exited, false);
    assert.equal(hello.control, false);
    assert.equal(typeof hello.seq, 'number');

    const scrollback = events[1].data;
    assert.ok(scrollback.lines.length > 0, 'the mock has output above the viewport');
    assert.ok(scrollback.lines.length <= SCROLLBACK_LIMIT);

    const screen = events[2].data;
    assert.equal(screen.rows.length, hello.rows, 'a screen carries every row');
    assert.deepEqual(
      screen.rows.map(row => row[0]),
      Array.from({ length: hello.rows }, (unused, index) => index)
    );
    assert.equal(typeof screen.cursor.x, 'number');
    assert.equal(typeof screen.cursor.y, 'number');
    assert.equal(screen.cursor.visible, true);

    // Every row is self-contained: it resets what came before and after itself.
    for (const line of scrollback.lines.concat(screen.rows.map(row => row[1]))) {
      assert.ok(line.startsWith('[0m'), `row does not open with a reset: ${JSON.stringify(line)}`);
      assert.ok(line.endsWith('[0m'), `row does not close with a reset: ${JSON.stringify(line)}`);
    }
    assert.equal(renderRow(''), '[0m', 'a blank row costs four bytes');
    assert.match(
      screen.rows.map(row => row[1]).join('\n'),
      /phone-bridge-probe/,
      'the screen is the session, not a placeholder'
    );
  });
});

test('a frame carries only the rows that moved, never the ones that did not', async () => {
  await withBridge({ mutateMs: 120 }, async (bridge, base) => {
    const { events } = await readStream(base, `/api/sessions/s-codex/stream?code=${CODE}`, {
      events: 8,
      timeoutMs: 4000,
    });
    const frames = events.filter(entry => entry.event === 'frame');
    assert.ok(frames.length >= 3, `expected frames, got ${events.map(e => e.event).join(',')}`);

    // The demonstration terminal rewrites its last two rows and nothing else.
    for (const frame of frames) {
      assert.ok(frame.data.rows.length <= 2, `a frame shipped ${frame.data.rows.length} rows`);
      for (const [index] of frame.data.rows) {
        assert.ok(index >= 22 && index <= 23, `row ${index} did not change but was sent`);
      }
      assert.equal(typeof frame.data.seq, 'number');
      assert.equal(typeof frame.data.cursor.y, 'number');
    }

    // Sequence numbers move forwards, one frame at a time.
    const seqs = frames.map(frame => frame.data.seq);
    for (let index = 1; index < seqs.length; index += 1) {
      assert.equal(seqs[index], seqs[index - 1] + 1);
    }

    // And the rows really are different from one frame to the next.
    assert.notEqual(frames[0].data.rows[0][1], frames[1].data.rows[0][1]);
  });
});

test('frames are capped at twelve a second however fast the screen changes', async () => {
  await withBridge({ mutateMs: 5 }, async (bridge, base) => {
    const { events, seconds } = await readStream(base, `/api/sessions/s-codex/stream?code=${CODE}`, {
      events: 10000,
      timeoutMs: 2000,
    });
    const frames = events.filter(entry => entry.event === 'frame').length;
    const stats = bridge.streamStats('s-codex');
    const fps = frames / seconds;
    assert.ok(frames > 5, `the screen must actually be changing, got ${frames} frames`);
    assert.ok(fps <= FRAME_FPS + 1, `${fps.toFixed(1)} frames a second is over the cap`);
    assert.ok(
      stats.mutations > frames * 2,
      `the cap must be doing something: ${stats.mutations} changes, ${frames} frames`
    );
  });
});

test('a resize says so and then repaints every row', async () => {
  await withBridge({}, async (bridge, base) => {
    const pending = readStream(base, `/api/sessions/s-codex/stream?code=${CODE}`, {
      events: 5,
      timeoutMs: 4000,
      until: collected => collected.some(entry => entry.event === 'resize') && collected.length >= 5,
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(bridge.resize('s-codex', 100, 30), true);

    const { events } = await pending;
    assert.deepEqual(
      events.map(entry => entry.event),
      ['hello', 'scrollback', 'screen', 'resize', 'screen']
    );
    assert.deepEqual(events[3].data, { cols: 100, rows: 30 });
    assert.equal(events[4].data.rows.length, 30, 'the repaint covers the new size');
    assert.ok(events[4].data.seq > events[2].data.seq);
  });
});

test('the stream takes the code in the header too, and refuses a wrong one', async () => {
  await withBridge({}, async (bridge, base) => {
    const withHeader = await readStream(base, '/api/sessions/s-codex/stream', {
      headers: { Authorization: AUTH },
      events: 1,
    });
    assert.equal(withHeader.status, 200);
    assert.equal(withHeader.events[0].event, 'hello');

    const refused = await fetch(`${base}/api/sessions/s-codex/stream?code=NOPE`);
    assert.equal(refused.status, 401);

    const missing = await fetch(`${base}/api/sessions/nope/stream?code=${CODE}`);
    assert.equal(missing.status, 404);
  });
});

test('an exited terminal streams its last screen and then exit', async () => {
  await withBridge({}, async (bridge, base) => {
    const { events, ended } = await readStream(base, `/api/sessions/s-cursor/stream?code=${CODE}`, {
      events: 10,
    });
    assert.deepEqual(
      events.map(entry => entry.event),
      ['hello', 'scrollback', 'screen', 'exit']
    );
    assert.equal(events[0].data.exited, true);
    assert.deepEqual(events[3].data, {});
    assert.ok(ended, 'the stream must end after exit');
  });
});

test('storm mode measures the frame budget against a naive full-screen protocol', async () => {
  await withBridge({ storm: true, stormSessionId: 's-fusion' }, async (bridge, base) => {
    const { seconds } = await readStream(base, `/api/sessions/s-fusion/stream?code=${CODE}`, {
      events: 100000,
      timeoutMs: 3000,
    });
    const stats = bridge.streamStats('s-fusion');
    const sentPerSecond = stats.sentBytes / seconds;
    const naivePerSecond = stats.naiveBytes / seconds;
    const ratio = stats.naiveBytes / stats.sentBytes;

    process.stdout.write(
      `\n  storm over ${seconds.toFixed(1)}s: ${stats.mutations} screen rewrites, ${stats.frames} frames\n` +
        `  sent      ${Math.round(sentPerSecond).toLocaleString('en-US')} bytes/second (gzipped changed rows)\n` +
        `  naive     ${Math.round(naivePerSecond).toLocaleString('en-US')} bytes/second (whole screen, every change)\n` +
        `  ratio     ${ratio.toFixed(1)}x\n`
    );

    assert.ok(stats.mutations > 30, `the storm must actually storm, got ${stats.mutations}`);
    assert.ok(stats.frames > 0, 'something has to reach the phone');
    assert.ok(stats.frames / seconds <= FRAME_FPS + 1, 'the cap still holds under a storm');
    assert.ok(ratio >= 5, `the changed-row protocol only saved ${ratio.toFixed(1)}x`);
  });
});

test('the terminal page is served with the code and refused without it', async () => {
  await withBridge({}, async (bridge, base) => {
    const page = await fetch(`${base}/terminal/s-claude?code=${DEFAULT_CODE}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    const html = await page.text();
    assert.ok(html.includes(bridge.vendorUrls.js), 'the page loads xterm from its hashed URL');
    assert.ok(html.includes(bridge.vendorUrls.css));
    assert.match(bridge.vendorUrls.js, /^\/vendor\/[0-9a-f]{12}\/xterm\.js$/);
    assert.match(html, /window\.linaTerminal/);
    assert.match(html, /resetZoom/);
    assert.match(html, /new EventSource/);
    assert.match(html, /ReactNativeWebView/);
    assert.match(html, /\/api\/sessions\/s-claude\/stream/);
    assert.match(html, /View only/, 'a page without control says so');

    const refused = await fetch(`${base}/terminal/s-claude`);
    assert.equal(refused.status, 401);

    const wrong = await fetch(`${base}/terminal/s-claude?code=NOT-THE-CODE`);
    assert.equal(wrong.status, 401);

    const missing = await fetch(`${base}/terminal/nope?code=${DEFAULT_CODE}`);
    assert.equal(missing.status, 404);
  });
});

test('the terminal page can never scroll sideways, and shows no scrollbars', async () => {
  await withBridge({}, async (bridge, base) => {
    const html = await (await fetch(`${base}/terminal/s-codex?code=${DEFAULT_CODE}`)).text();
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

    // Every wrapper, and the document itself.
    assert.match(css, /html, body \{[^}]*overflow: hidden; overflow-x: hidden;/);
    assert.match(css, /#pan \{[^}]*overflow: hidden; overflow-x: hidden;/);
    assert.match(css, /\.xterm-viewport \{[^}]*scrollbar-width: none;[^}]*overflow-x: hidden !important;/);
    assert.match(css, /\.xterm-viewport::-webkit-scrollbar \{ display: none;/);
    assert.match(css, /\.xterm-screen, \.xterm \{ overflow-x: hidden; \}/);
    assert.ok(!/overflow: auto/.test(css), 'no wrapper may scroll on its own');
    assert.ok(!/scrollbar-thumb/.test(css), 'no scrollbar is ever drawn');

    // The slim position indicator that replaces the scrollbar.
    assert.match(css, /#rail \{[^}]*width: 2px;/);
    assert.match(css, /#rail \{[^}]*opacity: 0;/);
    assert.match(css, /#rail\.shown \{ opacity: 1; \}/);

    // Pinch belongs to the page, so the browser must not claim it; a zoomed
    // page takes the drag too, because that is the pan.
    assert.match(css, /#pan \{[^}]*touch-action: pan-y;/);
    assert.match(css, /#pan\.zoomed \{ touch-action: none; \}/);

    // And the page really does run the geometry these tests check.
    assert.ok(html.includes(fitScale.toString()), 'the page runs the tested fitScale');
    assert.ok(html.includes(fitFontSize.toString()), 'the page runs the tested fitFontSize');
    assert.ok(html.includes(clampPan.toString()), 'the page runs the tested clampPan');
    assert.ok(html.includes(anchorPan.toString()), 'the page runs the tested anchorPan');
  });
});

test('the fit never draws the terminal wider than the viewport', () => {
  // The font size is chosen so the columns fit, and is floored, so the terminal
  // can only ever come out narrower than asked — never wider.
  for (const width of [320, 360, 390, 412, 430, 768, 1024]) {
    for (const cols of [40, 80, 100, 120, 200]) {
      const size = fitFontSize(width, cols, 0.6, MAX_FONT_SIZE);
      assert.ok(size <= MAX_FONT_SIZE, `${size} is above the ceiling`);
      assert.ok(size > 0, 'a font size is always produced');
      assert.ok(
        size * 0.6 * cols <= width + 1e-9,
        `${cols} columns at ${size}px need ${(size * 0.6 * cols).toFixed(1)}px of ${width}px`
      );
    }
  }

  // There is no floor: a narrow phone showing a wide terminal simply gets a
  // small font, and the reader zooms rather than scrolls.
  assert.ok(fitFontSize(320, 200, 0.6, MAX_FONT_SIZE) < 7);
  // A viewport wide enough keeps the desktop's own size.
  assert.equal(fitFontSize(4000, 80, 0.6, MAX_FONT_SIZE), MAX_FONT_SIZE);
  // Nothing measurable yet: fall back to the ceiling rather than to zero.
  assert.equal(fitFontSize(0, 80, 0.6, MAX_FONT_SIZE), MAX_FONT_SIZE);
  assert.equal(fitFontSize(390, 0, 0.6, MAX_FONT_SIZE), MAX_FONT_SIZE);

  // The residual transform closes whatever xterm's own cell rounding left,
  // so the drawn width at rest is the viewport width and never more.
  for (const viewport of [320, 390, 412, 1024]) {
    for (const natural of [180, 300, 389, 391, 640, 2400]) {
      const drawn = natural * fitScale(viewport, natural, 1);
      assert.ok(
        drawn <= viewport + 1e-9,
        `drawn ${drawn.toFixed(3)} exceeds the ${viewport}px viewport`
      );
      assert.ok(Math.abs(drawn - viewport) < 1e-9, 'and it fills it exactly');
    }
  }

  // Zoom is clamped to 0.6x…3x of that fit, in both directions.
  assert.equal(fitScale(390, 390, 10), 3);
  assert.equal(fitScale(390, 390, 0.1), 0.6);
  assert.equal(fitScale(390, 390, 1), 1);
  assert.equal(fitScale(390, 0, 1), 1, 'nothing measured yet is not a divide by zero');
});

test('panning is bounded so the content edges never leave the viewport', () => {
  // Content wider than the frame: draggable, but only over its own extent.
  assert.equal(clampPan(0, 390, 800, false), 0);
  assert.equal(clampPan(-100, 390, 800, false), -100);
  assert.equal(clampPan(-1000, 390, 800, false), -410, 'cannot drag past the far edge');
  assert.equal(clampPan(50, 390, 800, false), 0, 'cannot drag past the near edge');

  // Content that fits is pinned: left across, and bottom down, because that is
  // where a terminal's newest line is.
  assert.equal(clampPan(-50, 390, 200, false), 0);
  assert.equal(clampPan(-50, 600, 200, true), 400);
  assert.equal(clampPan(0, 600, 600, true), 0);

  // Zooming from the key bar anchors at the left edge and the foot of the view,
  // so column zero does not walk off to the left and the newest lines stay in
  // sight. A 600px view showing 300px of terminal, zoomed to 1.5x:
  const viewport = 600;
  const before = clampPan(0, viewport, 300, true);
  assert.equal(before, 300, 'a short screen sits at the bottom of the frame');
  assert.equal(anchorPan(0, 0, 1.5), 0, 'the left edge stays the left edge');
  assert.equal(
    clampPan(anchorPan(before, viewport, 1.5), viewport, 450, true),
    150,
    'and the foot of the screen stays at the foot of the frame'
  );
  // The centre anchor a pinch uses is the one that moves both edges.
  assert.equal(anchorPan(0, viewport / 2, 1.5), -150);
  assert.equal(anchorPan(-40, 0, 1.5), -60, 'an already-panned view scales with it');
  assert.equal(anchorPan(-40, 0, 0), -40, 'no scale change, no movement');
});

test('the page that may send keys carries send() and no view-only banner', async () => {
  await withBridge({ control: true }, async (bridge, base) => {
    const html = await (await fetch(`${base}/terminal/s-codex?code=${DEFAULT_CODE}`)).text();
    assert.match(html, /linaTerminal\.send/);
    assert.match(html, /"control":true/);
    assert.match(html, /id="banner" hidden/);
  });
});

test(
  'the xterm the page loads is content-addressed and cached forever',
  async () => {
    await withBridge({}, async (bridge, base) => {
      const immutable = 'public, max-age=31536000, immutable';

      const script = await fetch(`${base}${bridge.vendorUrls.js}`);
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type') || '', /javascript/);
      assert.equal(script.headers.get('cache-control'), immutable);
      const body = await script.text();
      assert.ok(body.length > 100000, 'that is not the xterm build');

      const css = await fetch(`${base}${bridge.vendorUrls.css}`);
      assert.equal(css.status, 200);
      assert.match(css.headers.get('content-type') || '', /text\/css/);
      assert.equal(css.headers.get('cache-control'), immutable);

      const fit = await fetch(`${base}${bridge.vendorUrls.fit}`);
      assert.equal(fit.status, 200);
      assert.match(await fit.text(), /FitAddon/);

      // The hash is the content, so anything else under it is not that content.
      assert.equal((await fetch(`${base}${bridge.vendorUrls.js.replace(/\/[^/]+$/, '/nope.js')}`)).status, 404);
      assert.equal((await fetch(`${base}/vendor/deadbeefcafe/xterm.js`)).status, 404);

      // Two bridges over the same installation agree on the hash.
      const second = createMockBridge({ tickMs: 0 });
      assert.equal(second.vendorUrls.js, bridge.vendorUrls.js);
      await second.close();
    });
  }
);

test('the Claude terminal is parked on a prompt and nothing else is', async () => {
  await withBridge({}, async (bridge, base) => {
    const state = await (await get(base, '/api/state?revision=0&wait=0')).json();
    const claude = state.sessions.find(session => session.id === 's-claude');
    assert.deepEqual(claude.needsInput, {
      kind: 'menu',
      prompt: 'Edit apps/desktop/frontend/components/StatusPill.tsx?',
      options: [
        { key: '1', label: 'Yes' },
        { key: '2', label: "Yes, and don't ask again" },
        { key: '3', label: 'No, tell Claude what to do differently' },
      ],
    });
    for (const session of state.sessions) {
      if (session.id === 's-claude') continue;
      assert.equal(session.needsInput, null, `${session.id} must not claim a prompt`);
    }
  });
});

test('answering the prompt with a key clears it', async () => {
  await withBridge({ control: true }, async (bridge, base) => {
    const answer = await post(base, '/api/sessions/s-claude/keys', { data: `1${TERMINAL_KEYS.enter}` });
    assert.equal(answer.status, 200);
    const state = await (await get(base, '/api/state?revision=0&wait=0')).json();
    const claude = state.sessions.find(session => session.id === 's-claude');
    assert.equal(claude.needsInput, null);
    assert.equal(claude.attention, false);
  });
});

test('the test hooks park a terminal on a prompt and let it go again', async () => {
  await withBridge({}, async (bridge, base) => {
    const before = await (await get(base, '/api/state?revision=0&wait=0')).json();
    assert.equal(before.sessions.find(session => session.id === 's-fusion').needsInput, null);

    // No code: these stand in for something happening on the desktop, exactly
    // as the approval hooks stand in for somebody pressing Allow.
    const set = await fetch(`${base}/__mock/needs-input/s-fusion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Apply the patch?', options: [{ key: '1', label: 'Yes' }] }),
    });
    assert.equal(set.status, 200);

    const asking = await (await get(base, '/api/state?revision=0&wait=0')).json();
    const parked = asking.sessions.find(session => session.id === 's-fusion');
    assert.deepEqual(parked.needsInput, {
      kind: 'menu',
      prompt: 'Apply the patch?',
      options: [{ key: '1', label: 'Yes' }],
    });
    assert.equal(parked.attention, true);
    // The revision has to move, or a parked long poll never learns about it.
    assert.ok(asking.revision > before.revision, 'setting a prompt must bump the revision');

    const cleared = await fetch(`${base}/__mock/needs-input/s-fusion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    assert.equal(cleared.status, 200);
    const after = await (await get(base, '/api/state?revision=0&wait=0')).json();
    const free = after.sessions.find(session => session.id === 's-fusion');
    assert.equal(free.needsInput, null);
    assert.equal(free.attention, false);
    assert.ok(after.revision > asking.revision);

    // A prompt with nothing said about it is the demonstration one.
    await fetch(`${base}/__mock/needs-input/s-fusion`, { method: 'POST' });
    const fallback = await (await get(base, '/api/state?revision=0&wait=0')).json();
    assert.equal(
      fallback.sessions.find(session => session.id === 's-fusion').needsInput.options.length,
      2
    );

    const missing = await fetch(`${base}/__mock/needs-input/nope`, { method: 'POST' });
    assert.equal(missing.status, 404);
  });
});

test('the test hooks move one terminal to any status the contract has', async () => {
  await withBridge({}, async (bridge, base) => {
    const before = await (await get(base, '/api/state?revision=0&wait=0')).json();
    assert.equal(before.sessions.find(session => session.id === 's-fusion').status, 'working');

    const done = await fetch(`${base}/__mock/status/s-fusion/done`, { method: 'POST' });
    assert.equal(done.status, 200);
    const after = await (await get(base, '/api/state?revision=0&wait=0')).json();
    const session = after.sessions.find(entry => entry.id === 's-fusion');
    assert.equal(session.status, 'done');
    assert.equal(session.statusLabel, 'Done');
    assert.ok(after.revision > before.revision, 'a status change must bump the revision');

    const nonsense = await fetch(`${base}/__mock/status/s-fusion/elsewhere`, { method: 'POST' });
    assert.equal(nonsense.status, 400);
    const missing = await fetch(`${base}/__mock/status/nope/done`, { method: 'POST' });
    assert.equal(missing.status, 404);
  });
});

test('keys are echoed into the screen and into the next frame', async () => {
  await withBridge({ control: true }, async (bridge, base) => {
    const pending = readStream(base, `/api/sessions/s-codex/stream?code=${CODE}`, {
      events: 4,
      timeoutMs: 4000,
    });
    await new Promise(resolve => setTimeout(resolve, 200));

    const response = await post(base, '/api/sessions/s-codex/keys', { data: 'ls -la' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.actionId, 'string');

    const { events } = await pending;
    assert.deepEqual(
      events.map(entry => entry.event),
      ['hello', 'scrollback', 'screen', 'frame']
    );
    const frame = events[3].data;
    assert.equal(frame.seq, 1);
    assert.equal(frame.rows.length, 1, 'typing on one line changes one row');
    assert.match(frame.rows[0][1], /ls -la/);

    const screen = await (await get(base, '/api/sessions/s-codex/screen')).json();
    assert.ok(screen.text.endsWith('ls -la'), `the screen must carry the keys too: ${JSON.stringify(screen.text.slice(-12))}`);

    // A Return at the bottom of a terminal scrolls it, and a scroll really does
    // move every row: the diff is honest about that rather than cheap about it.
    const scrolled = readStream(base, `/api/sessions/s-codex/stream?code=${CODE}`, {
      events: 4,
      timeoutMs: 4000,
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    await post(base, '/api/sessions/s-codex/keys', { data: TERMINAL_KEYS.enter });
    const after = await scrolled;
    const scrollFrame = after.events[3];
    assert.equal(scrollFrame.event, 'frame');
    assert.equal(scrollFrame.data.rows.length, 24, 'a scroll changes the whole viewport');

    // The control bytes a phone keyboard cannot type arrive as themselves.
    await post(base, '/api/sessions/s-codex/keys', { data: TERMINAL_KEYS.interrupt });
    const caret = await (await get(base, '/api/sessions/s-codex/screen')).json();
    assert.ok(caret.text.endsWith('^C'), `expected a caret-C echo, got ${JSON.stringify(caret.text.slice(-8))}`);
  });
});

test('keys are refused without control, and not served at all in read-only mode', async () => {
  await withBridge({}, async (bridge, base) => {
    const response = await post(base, '/api/sessions/s-codex/keys', { data: 'x' });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, error: 'control not allowed' });
  });

  await withBridge({ readOnly: true }, async (bridge, base) => {
    const response = await post(base, '/api/sessions/s-codex/keys', { data: 'x' });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { ok: false, error: 'not found' });

    const html = await (await fetch(`${base}/terminal/s-codex?code=${DEFAULT_CODE}`)).text();
    assert.match(html, /"control":false/, 'a read-only desktop never grants control');
  });

  // Empty keys and an exited terminal keep their own answers.
  await withBridge({ control: true }, async (bridge, base) => {
    assert.equal((await post(base, '/api/sessions/s-codex/keys', { data: '' })).status, 400);
    assert.equal((await post(base, '/api/sessions/s-cursor/keys', { data: 'x' })).status, 409);
  });
});

test('the key bar sends the bytes a terminal expects', () => {
  assert.equal(TERMINAL_KEYS.escape, '');
  assert.equal(TERMINAL_KEYS.tab, '\t');
  assert.equal(TERMINAL_KEYS.up, '[A');
  assert.equal(TERMINAL_KEYS.down, '[B');
  assert.equal(TERMINAL_KEYS.left, '[D');
  assert.equal(TERMINAL_KEYS.right, '[C');
  assert.equal(TERMINAL_KEYS.enter, '\r');
  assert.equal(TERMINAL_KEYS.interrupt, '');
  assert.equal(TERMINAL_KEYS.slash, '/');

  // Ctrl + a letter is that letter's ASCII control code, either case.
  assert.equal(controlCode('c'), '');
  assert.equal(controlCode('C'), '');
  assert.equal(controlCode('a'), '');
  assert.equal(controlCode('z'), '');
  assert.equal(controlCode('['), '');
  assert.equal(controlCode('c'), TERMINAL_KEYS.interrupt);

  // The three the key bar gives a button of their own.
  assert.equal(controlCode('d'), '');
  assert.equal(controlCode('l'), '');

  // Anything without a control code sends nothing.
  assert.equal(controlCode('1'), null);
  assert.equal(controlCode(' '), null);
  assert.equal(controlCode(''), null);
  assert.equal(controlCode(null), null);
});

test('a prompt is read defensively, and a parked terminal counts as waiting', () => {
  const menu = normalizeNeedsInput({
    kind: 'menu',
    prompt: ' Edit the file? ',
    options: [{ key: ' 1 ', label: 'Yes' }, { key: 'y' }, { junk: true }, null],
  });
  assert.deepEqual(menu, {
    kind: 'menu',
    prompt: 'Edit the file?',
    options: [{ key: '1', label: 'Yes' }, { key: 'y', label: 'y' }],
  });

  // An unknown kind still renders; nothing to show at all does not.
  assert.equal(normalizeNeedsInput({ kind: 'nonsense', prompt: 'Go on?' }).kind, 'menu');
  assert.equal(normalizeNeedsInput({ prompt: '   ', options: [] }), null);
  assert.equal(normalizeNeedsInput(null), null);
  assert.equal(normalizeNeedsInput('yes'), null);
  assert.equal(sessionNeedsInput({ needsInput: null }), false);
  assert.equal(sessionNeedsInput({ needsInput: { prompt: 'Go on?' } }), true);

  // A terminal the desktop calls working, but which is waiting for a person,
  // is counted as waiting — and is not counted twice.
  const counts = { working: 2, waiting: 1, done: 1, failed: 0 };
  const sessions = [
    { status: 'working', needsInput: { prompt: 'Go on?' } },
    { status: 'working' },
    { status: 'waiting', needsInput: { prompt: 'And this?' } },
    { status: 'done' },
  ];
  assert.deepEqual(countsWithNeedsInput(counts, sessions), {
    working: 1,
    waiting: 2,
    done: 1,
    failed: 0,
  });

  // Statuses the tally never shows give nothing back.
  assert.deepEqual(
    countsWithNeedsInput({ working: 0, waiting: 0, done: 0, failed: 0 }, [
      { status: 'idle', needsInput: { prompt: 'Go on?' } },
    ]),
    { working: 0, waiting: 1, done: 0, failed: 0 }
  );
  assert.deepEqual(countsWithNeedsInput(null, null), { working: 0, waiting: 0, done: 0, failed: 0 });
});

test('the inbox holds everything waiting for a person, prompts first', () => {
  const sessions = [
    { id: 'a', status: 'working', lastActivityAt: 500 },
    { id: 'b', status: 'waiting', lastActivityAt: 100, snippet: 'Stopped at the prompt' },
    { id: 'c', status: 'working', lastActivityAt: 200, needsInput: { prompt: 'Edit it?\nsecond line' } },
    { id: 'd', status: 'done', lastActivityAt: 900 },
    { id: 'e', status: 'waiting', lastActivityAt: 400 },
  ];
  assert.deepEqual(
    waitingForYou(sessions).map(session => session.id),
    ['c', 'e', 'b'],
    'a parsed prompt outranks a bare waiting status, then it is most recent first'
  );

  // Nothing waiting, no section.
  assert.deepEqual(waitingForYou([{ id: 'a', status: 'working' }]), []);
  assert.deepEqual(waitingForYou(null), []);

  // The row shows one line: the prompt's first, or the snippet when there is none.
  assert.equal(promptLine(sessions[2]), 'Edit it?');
  assert.equal(promptLine(sessions[1]), 'Stopped at the prompt');
  assert.equal(promptLine({ status: 'waiting' }), '');
});

test('the mock puts its waiting terminals in the inbox the phone will draw', async () => {
  await withBridge({}, async (bridge, base) => {
    const state = await (await get(base, '/api/state?revision=0&wait=0')).json();
    const inbox = waitingForYou(state.sessions);
    assert.deepEqual(
      inbox.map(session => session.id),
      ['s-claude'],
      'only the parked Claude terminal is waiting in the demonstration data'
    );
    assert.equal(promptLine(inbox[0]), 'Edit apps/desktop/frontend/components/StatusPill.tsx?');
  });
});

// --- discovery and pairing ---------------------------------------------------

function postNoAuth(base, path, payload) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

test('discover answers without a pairing code', async () => {
  await withBridge({}, async (bridge, base) => {
    const response = await fetch(`${base}/api/discover`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.app, 'lina-terminal');
    assert.equal(body.bridge, 1);
    assert.equal(body.readOnly, false);
    assert.equal(typeof body.host, 'string');
    assert.equal(typeof body.version, 'string');
    assert.equal(body.desktopId, bridge.desktopId);

    // The same desktop keeps the same identity, so discovery can dedupe on it.
    const again = await (await fetch(`${base}/api/discover`)).json();
    assert.equal(again.desktopId, body.desktopId);
  });
});

test('a read-only desktop says so in discovery', async () => {
  await withBridge({ readOnly: true }, async (bridge, base) => {
    const body = await (await fetch(`${base}/api/discover`)).json();
    assert.equal(body.readOnly, true);
  });
});

test('an approved pairing request hands over the code exactly once', async () => {
  await withBridge({ pairAnswerMs: 120 }, async (bridge, base) => {
    const requested = await postNoAuth(base, '/api/pair', { deviceName: "Ahmed's Pixel", platform: 'android' });
    assert.equal(requested.status, 200);
    const request = await requested.json();
    assert.equal(request.ok, true);
    assert.equal(typeof request.requestId, 'string');
    assert.ok(request.expiresAt > Date.now(), 'the request must carry a future expiry');

    // Before anybody answers, the request is pending.
    const immediate = await (await fetch(`${base}/api/pair/${request.requestId}?wait=0`)).json();
    assert.equal(immediate.status, 'pending');
    assert.equal(immediate.code, undefined);

    // The long poll parks and wakes on the approval.
    const startedAt = Date.now();
    const approved = await (await fetch(`${base}/api/pair/${request.requestId}?wait=5000`)).json();
    const elapsed = Date.now() - startedAt;
    assert.equal(approved.status, 'approved');
    assert.equal(approved.code, DEFAULT_CODE);
    assert.ok(elapsed < 3000, `the poll should wake on approval, took ${elapsed}ms`);

    // Asked again, it is still approved but the code is not repeated.
    const repeat = await (await fetch(`${base}/api/pair/${request.requestId}?wait=0`)).json();
    assert.equal(repeat.status, 'approved');
    assert.equal(repeat.code, undefined);

    // And the delivered code is the one the bridge actually accepts.
    const hello = await fetch(`${base}/api/hello`, {
      headers: { Authorization: `Bearer ${approved.code.replace(/-/g, '')}` },
    });
    assert.equal(hello.status, 200);
  });
});

test('a denied pairing request reports denied and never carries a code', async () => {
  await withBridge({ pairMode: 'deny', pairAnswerMs: 80 }, async (bridge, base) => {
    const request = await (await postNoAuth(base, '/api/pair', { deviceName: 'Phone', platform: 'ios' })).json();
    const answer = await (await fetch(`${base}/api/pair/${request.requestId}?wait=5000`)).json();
    assert.equal(answer.status, 'denied');
    assert.equal(answer.code, undefined);
  });
});

test('a pairing request nobody answers expires', async () => {
  await withBridge({ pairMode: 'manual', pairExpiryMs: 120 }, async (bridge, base) => {
    const request = await (await postNoAuth(base, '/api/pair', { deviceName: 'Phone', platform: 'ios' })).json();
    const answer = await (await fetch(`${base}/api/pair/${request.requestId}?wait=3000`)).json();
    assert.equal(answer.status, 'expired');
    assert.equal(answer.code, undefined);
  });
});

test('a fourth pending pairing request is refused with 429', async () => {
  await withBridge({ pairMode: 'manual' }, async (bridge, base) => {
    for (let index = 0; index < 3; index += 1) {
      const response = await postNoAuth(base, '/api/pair', { deviceName: `Phone ${index}`, platform: 'ios' });
      assert.equal(response.status, 200, `request ${index + 1} should be accepted`);
    }
    const fourth = await postNoAuth(base, '/api/pair', { deviceName: 'Phone 4', platform: 'ios' });
    assert.equal(fourth.status, 429);
    const body = await fourth.json();
    assert.equal(body.ok, false);
    assert.equal(typeof body.error, 'string');
  });
});

test('answering a manual request wakes the phone that is waiting', async () => {
  await withBridge({ pairMode: 'manual' }, async (bridge, base) => {
    const request = await (await postNoAuth(base, '/api/pair', { deviceName: 'Phone', platform: 'ios' })).json();
    const pending = fetch(`${base}/api/pair/${request.requestId}?wait=4000`);
    await new Promise(resolve => setTimeout(resolve, 150));

    const approved = await postNoAuth(base, `/__mock/approve/${request.requestId}`);
    assert.equal(approved.status, 200);

    const answer = await (await pending).json();
    assert.equal(answer.status, 'approved');
    assert.equal(answer.code, DEFAULT_CODE);
  });
});

test('an unknown pairing request is 404, not pending', async () => {
  await withBridge({}, async (bridge, base) => {
    const response = await fetch(`${base}/api/pair/nope?wait=0`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.deepEqual(body, { ok: false, error: 'not found' });
  });
});

test('the addresses discovery tries cover the emulator and the dev host', () => {
  assert.equal(hostFromHostUri('192.168.1.20:8081'), '192.168.1.20');
  assert.equal(hostFromHostUri('exp://192.168.1.20:8081'), '192.168.1.20');
  assert.equal(hostFromHostUri(''), null);

  // A real Metro host is tried on both ports, then localhost.
  assert.deepEqual(seedCandidates({ hostUri: '192.168.1.20:8081', platform: 'ios' }), [
    { host: '192.168.1.20', port: 47831 },
    { host: '192.168.1.20', port: 47832 },
    { host: 'localhost', port: 47831 },
    { host: 'localhost', port: 47832 },
  ]);

  // Inside an Android emulator, localhost is the emulator, so the host alias is added.
  const emulator = seedCandidates({ hostUri: 'localhost:8081', platform: 'android' });
  assert.ok(emulator.some(entry => entry.host === ANDROID_HOST_ALIAS && entry.port === 47831));
  assert.ok(emulator.some(entry => entry.host === 'localhost'));

  // iOS with no dev server: just localhost, no emulator alias.
  const bare = seedCandidates({ hostUri: null, platform: 'ios' });
  assert.deepEqual(bare, [
    { host: 'localhost', port: 47831 },
    { host: 'localhost', port: 47832 },
  ]);

  // The subnet sweep covers .1-.254 minus the phone itself, on the bridge port only.
  const sweep = subnetCandidates('192.168.2.37');
  assert.equal(sweep.length, 253);
  assert.ok(sweep.every(entry => entry.port === 47831));
  assert.ok(!sweep.some(entry => entry.host === '192.168.2.37'));
  assert.equal(sweep[0].host, '192.168.2.1');
  assert.equal(sweep[sweep.length - 1].host, '192.168.2.254');
  assert.equal(subnetLabel('192.168.2.37'), '192.168.2.x');

  // Nothing to scan without a real address.
  assert.deepEqual(subnetCandidates(null), []);
  assert.deepEqual(subnetCandidates('127.0.0.1'), []);
});
