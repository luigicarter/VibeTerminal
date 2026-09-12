const readline = require("readline");
const { encodeTerminalControls } = require('../shared/terminalControls.cjs');
const { createTerminalHistory } = require('./terminalHistory.cjs');
const { windowsPtyHostOptions, describePtyHost, spawnPty } = require('./ptyHostOptions.cjs');
const sessions = new Map();
let transportBlocked = false;
const outgoingEvents = [];
let outgoingOffset = 0;

function updateSessionFlow(session) {
  if (!session.terminal) return;
  const paused = transportBlocked || session.historyBlocked === true;
  if (paused === Boolean(session.outputPaused)) return;
  session.outputPaused = paused;
  if (paused) session.terminal.pause?.();
  else session.terminal.resume?.();
}
function flushEvents() {
  while (!transportBlocked && outgoingOffset < outgoingEvents.length) {
    if (process.stdout.write(outgoingEvents[outgoingOffset++]) === false) {
      transportBlocked = true;
      for (const session of sessions.values()) updateSessionFlow(session);
    }
  }
  if (outgoingOffset) { outgoingEvents.splice(0, outgoingOffset); outgoingOffset = 0; }
}
function writeEvent(event) {
  outgoingEvents.push(`${JSON.stringify(event)}\n`);
  flushEvents();
}
process.stdout.on?.('drain', () => {
  transportBlocked = false;
  flushEvents();
  for (const session of sessions.values()) updateSessionFlow(session);
});

let pty = null;
try {
  pty = require("node-pty");
} catch (error) {
  emit({
    type: "host-error",
    message: `node-pty could not be loaded: ${error.message}`
  });
}

const stopObserver = require('./observedStop.cjs').createHostStopObserver({ lookup: id => sessions.get(id), emit });
const checkedResults = new Map();
const pendingActions = new Map();
const NATIVE_SUBMIT_DELAY_MS = 200;

function emit(event) {
  const session = sessions.get(event.id);
  if (session?.pendingEvents?.length && event.type !== 'action-result' && event.type !== 'stop-observed-result') {
    session.pendingEvents.push({ event: { at: Date.now(), ...event } });
    return;
  }
  writeEvent({ at: Date.now(), ...event });
}

function debug(event) {
  const file = process.env.VIBE_SCREENSHOT_PTY_DEBUG;
  if (!file) {
    return;
  }

  try {
    require("fs").appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    // Screenshot diagnostics must never affect terminal behavior.
  }
}

function shellForPlatform() {
  if (process.platform === "win32") {
    return {
      file: process.env.VIBE_TERMINAL_SHELL || "powershell.exe",
      // ConPTY consoles default to the OEM code page (usually 437), which
      // mangles the UTF-8 box-drawing output of node-based TUIs (kimi,
      // claude) into mojibake before xterm.js ever sees it. Run interactive
      // PowerShell sessions with UTF-8 console encodings (the silent
      // equivalent of `chcp 65001`) so those bytes decode correctly.
      args: /powershell|pwsh/i.test(
        process.env.VIBE_TERMINAL_SHELL || "powershell.exe"
      )
        ? [
            "-NoLogo",
            "-NoExit",
            "-Command",
            "[Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8"
          ]
        : ["-NoLogo"]
    };
  }

  return {
    file: process.env.SHELL || "bash",
    args: []
  };
}

function terminalEnvironment(instrumentationEnv = {}, stripEnv = []) {
  const inheritedTerm = process.env.TERM;
  const term =
    !inheritedTerm || inheritedTerm.toLowerCase() === "dumb"
      ? "xterm-256color"
      : inheritedTerm;

  const base = { ...process.env };
  // Custom-provider panes ask us to drop inherited vars (ANTHROPIC_* and friends)
  // so the pane's explicit env is the only auth/endpoint in play. Env keys are
  // case-insensitive on Windows, so match lowercase there.
  if (Array.isArray(stripEnv) && stripEnv.length > 0) {
    const caseInsensitive = process.platform === "win32";
    const strip = new Set(
      stripEnv
        .filter((key) => typeof key === "string" && key)
        .map((key) => (caseInsensitive ? key.toLowerCase() : key))
    );
    for (const key of Object.keys(base)) {
      if (strip.has(caseInsensitive ? key.toLowerCase() : key)) {
        delete base[key];
      }
    }
  }

  return {
    ...base,
    TERM: term,
    COLORTERM: process.env.COLORTERM || "truecolor",
    TERM_PROGRAM: "LinaTerminal",
    ...instrumentationEnv
  };
}

function emitSnapshot(id, session) {
  const event = {
    at: Date.now(),
    id,
    type: "snapshot",
    isRunning: Boolean(session.terminal),
    launchPending: Boolean(session.launchPending),
    launchToken: session.launchToken,
    generation: session.generation,
    terminalTitle: session.terminalTitle,
    exitCode: session.exitCode,
    signal: session.signal,
    cols: session.cols, rows: session.rows, sequence: session.sequence, outputAt: session.outputAt,
    ...inputState(session)
  };
  // Freeze the snapshot's position in the stream while its decoder catches up.
  // Later data/resize/exit events must arrive AFTER this replay, including when
  // multiple attaches race. Other panes and normal live output remain immediate.
  const slot = {};
  session.pendingEvents.push(slot);
  session.history.snapshot(snapshot => {
    if (sessions.get(id) !== session) return;
    slot.event = { ...event, ...snapshot };
    while (session.pendingEvents[0]?.event) {
      writeEvent(session.pendingEvents.shift().event);
    }
  });
}

function matchesSession(session, payload) {
  return Boolean(session) &&
    (payload.generation === undefined || payload.generation === session.generation) &&
    (payload.launchToken === undefined || Number(payload.launchToken) === session.launchToken);
}

// Conservative "user may have an unsent draft" marker, not a reconstruction
// of a provider editor. Output never clears it; arrow/tab input can dirty it.
function inputState(session) {
  return { inputRevision: session.inputRevision, manualInputPending: Boolean(session.manualInputPending),
    interactionInputPending: Boolean(session.interactionInputPending || session.heldMouseButton), ownerRequestId: session.ownerRequestId || session.mouseOwnerRequestId || null };
}
function inputChanged(session) {
  session.inputRevision += 1;
  emit({ type: 'input-state', id: session.id, generation: session.generation, ...inputState(session) });
}
function cancelSessionSubmission(session) {
  for (const entry of [...pendingActions.values()]) if (entry.session === session) entry.cancel();
}
function noteManualInput(session, data) {
  if (typeof data !== "string" || !data) return;
  // xterm emits these replies through onData without a user editing anything.
  // Match whole packets only; navigation/paste and mixed packets stay dirty.
  if (/^\x1b\[(?:[IO]|\??\d+;\d+R|[?>][0-9]+(?:;[0-9]+)*c|[03]n)$/.test(data)) return;
  cancelSessionSubmission(session);
  session.interactionInputPending = false;
  session.ownerRequestId = null;
  session.heldMouseButton = null;
  session.mouseOwnerRequestId = null;
  session.manualInputPending = !["\r", "\n", "\r\n", "\x03"].includes(data);
  inputChanged(session);
}

// Observe OSC titles without changing the byte stream supplied to xterm.
function captureTerminalTitle(session, data, id) {
  for (const character of data) {
    if (session.oscState === "escape") {
      session.oscState = character === "]" ? "osc" : character === "\x1b" ? "escape" : "text";
      session.oscText = "";
    } else if (session.oscState === "osc" || session.oscState === "osc-escape") {
      if (character === "\x07" || character === "\x9c" ||
          (session.oscState === "osc-escape" && character === "\\")) {
        const match = /^(?:0|2);([\s\S]*)$/.exec(session.oscText);
        if (match) {
          const title = match[1].replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, 512);
          if (title !== session.terminalTitle) {
            session.terminalTitle = title;
            emit({ id, type: "title", title, generation: session.generation, launchToken: session.launchToken });
          }
        }
        session.oscState = "text";
        session.oscText = "";
      } else if (character === "\x1b") {
        session.oscState = "osc-escape";
      } else {
        if (session.oscState === "osc-escape") session.oscText += "\x1b";
        session.oscText += character;
        session.oscState = session.oscText.length > 4096 ? "text" : "osc";
      }
    } else if (character === "\x1b") {
      session.oscState = "escape";
    } else if (character === "\x9d") {
      session.oscState = "osc";
      session.oscText = "";
    }
  }
}

function detachSessionListeners(session) {
  session.dataSubscription?.dispose?.();
  session.exitSubscription?.dispose?.();
  session.dataSubscription = session.exitSubscription = undefined;
}

function disposeSession(session) {
  detachSessionListeners(session);
  session.history?.dispose();
  session.pendingEvents.length = 0;
}

function createSession(payload) {
  const hostOptions = windowsPtyHostOptions();
  // Logged once the console host is known, so `host` is the host actually used
  // (spawnPty can fall back to the inbox conhost).
  const logCreate = (host) => debug({
    type: "create",
    id: payload.id,
    command: payload.command,
    cwd: payload.cwd,
    launchToken: payload.launchToken,
    cols: payload.cols,
    rows: payload.rows,
    host
  });

  if (!pty) {
    logCreate(describePtyHost(hostOptions));
    emit({
      id: payload.id,
      type: "error",
      generation: payload.generation,
      launchToken: payload.launchToken,
      message: "Cannot create terminal because node-pty is unavailable."
    });
    return;
  }

  if (sessions.has(payload.id)) {
    const existingSession = sessions.get(payload.id);
    const incomingToken = Number(payload.launchToken || 0);
    const existingToken = Number(existingSession?.launchToken || 0);
    if (incomingToken < existingToken ||
        (incomingToken === existingToken && payload.generation !== undefined &&
          payload.generation !== existingSession.generation)) return;

    // A newer launch token means the renderer asked for a restart/relaunch. If a
    // stale create() for the previous launch raced in and re-spawned first, the
    // dedup-to-snapshot path below would otherwise swallow the restart and leave
    // the pane running the pre-restart command. Supersede it: kill the old shell
    // and fall through to spawn the new one. (The old terminal's onExit is
    // suppressed once the new session replaces it in the map.) An already-exited
    // session (terminal null) supersedes the same way — replaying its dead
    // snapshot would swallow the relaunch entirely.
    if (incomingToken > existingToken) {
      cancelSessionSubmission(existingSession);
      existingSession?.terminal?.kill();
      disposeSession(existingSession);
      sessions.delete(payload.id);
    } else {
      if (existingSession?.terminal && (payload.cols || payload.rows)) {
        const cols = Math.max(20, Number(payload.cols || 100));
        const rows = Math.max(6, Number(payload.rows || 28));
        if (existingSession.cols !== cols || existingSession.rows !== rows) {
          existingSession.terminal.resize(cols, rows);
          existingSession.cols = cols;
          existingSession.rows = rows;
          existingSession.history.resize(cols, rows);
          emit({ id: payload.id, type: "resize", generation: existingSession.generation, cols, rows });
          debug({ type: "dedup-resize", id: payload.id, cols, rows });
        } else {
          debug({ type: "dedup-resize-skipped", id: payload.id, cols, rows });
        }
      }

      if (existingSession) {
        emitSnapshot(payload.id, existingSession);
      }

      logCreate(describePtyHost(hostOptions));
      return;
    }
  }

  const shell = shellForPlatform();
  const cols = Math.max(20, Number(payload.cols || 100));
  const rows = Math.max(6, Number(payload.rows || 28));
  const cwd = payload.cwd || process.cwd();
  const instrumentationEnv =
    payload.instrumentation && typeof payload.instrumentation === "object"
      ? payload.instrumentation.env || {}
      : {};
  const instrumentationStripEnv =
    payload.instrumentation &&
    typeof payload.instrumentation === "object" &&
    Array.isArray(payload.instrumentation.stripEnv)
      ? payload.instrumentation.stripEnv
      : [];
  const session = {
    id: payload.id, inputRevision: 0, interactionInputPending: false, ownerRequestId: null,
    terminal: null,
    launchPending: Boolean(payload.command),
    history: null,
    pendingEvents: [],
    cols,
    rows,
    launchToken: Number(payload.launchToken || 0),
    generation: payload.generation,
    terminalTitle: "",
    bracketedPaste: false,
    manualInputPending: false,
    modeTail: "",
    oscState: "text",
    oscText: "",
    exitCode: undefined,
    signal: undefined,
    sequence: 0, outputAt: null
  };

  try {
    session.history = createTerminalHistory(cols, rows, { onBackpressure: blocked => {
      session.historyBlocked = blocked;
      updateSessionFlow(session);
    } });
    const { terminal, host, fallbackError } = spawnPty(pty, shell.file, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: terminalEnvironment(instrumentationEnv, instrumentationStripEnv)
    }, hostOptions);
    logCreate(host);
    if (fallbackError) {
      debug({ type: "host-fallback", id: payload.id, error: String(fallbackError.message || fallbackError) });
    }

    session.terminal = terminal;
    sessions.set(payload.id, session);
    updateSessionFlow(session);
    stopObserver.track(session, terminal, exited => terminal.onExit(exited));
    emit({ id: payload.id, type: "created", generation: session.generation, launchToken: session.launchToken, cols, rows, pid: terminal.pid, launchPending: session.launchPending, ...inputState(session) });

    session.dataSubscription = terminal.onData((data) => {
      if (sessions.get(payload.id) !== session) {
        return;
      }

      session.history.write(data);
      const modeText = session.modeTail + data;
      const modes = /\x1b\[\?([0-9;]+)([hl])/g;
      for (const match of modeText.matchAll(modes)) {
        if (match[1].split(";").includes("2004")) session.bracketedPaste = match[2] === "h";
        if (match[1].split(";").includes("1")) session.applicationCursorKeys = match[2] === "h";
        for (const mode of match[1].split(';').map(Number)) {
          if (mode === 1006) session.mouseSgr = match[2] === 'h';
          if ([1000, 1002, 1003].includes(mode)) {
            if (match[2] === 'h') session.mouseTracking = mode;
            else if (session.mouseTracking === mode) session.mouseTracking = null;
          }
        }
      }
      // Retain only a possible incomplete mode sequence across output chunks.
      session.modeTail = modeText.match(/\x1b(?:\[(?:\?[0-9;]{0,64})?)?$/)?.[0] || "";
      captureTerminalTitle(session, data, payload.id);
      session.sequence += 1;
      session.outputAt = Date.now();
      emit({
        id: payload.id,
        type: "data",
        generation: session.generation,
        launchToken: session.launchToken,
        data, sequence: session.sequence, outputAt: session.outputAt
      });
    });

    session.exitSubscription = terminal.onExit(({ exitCode, signal }) => {
      detachSessionListeners(session);
      const currentSession = sessions.get(payload.id);
      if (currentSession !== session) {
        return;
      }

      cancelSessionSubmission(session);
      session.terminal = null;
      session.exitCode = exitCode;
      session.signal = signal;
      emit({
        id: payload.id,
        type: "exit",
        generation: session.generation,
        launchToken: session.launchToken,
        exitCode,
        signal
      });
    });

    if (payload.command) {
      const lineEnding = process.platform === "win32" ? "\r" : "\n";
      setTimeout(() => {
        if (sessions.get(payload.id) === session && session.terminal === terminal) {
          debug({
            type: "write-command",
            id: payload.id,
            command: payload.command
          });
          try {
            terminal.write(`${payload.command}${lineEnding}`);
            session.launchPending = false;
            emit({ id: payload.id, type: "launch-ready", generation: session.generation, launchToken: session.launchToken });
          } catch (error) {
            emit({ id: payload.id, type: "error", generation: session.generation, launchToken: session.launchToken, message: `Terminal launcher failed: ${error.message}` });
          }
        }
      }, 250);
    }
  } catch (error) {
    logCreate(describePtyHost(hostOptions));
    disposeSession(session);
    emit({
      id: payload.id,
      type: "error",
      generation: payload.generation,
      launchToken: payload.launchToken,
      message: error.message
    });
  }
}

function handleMessage(message) {
  switch (message.type) {
    case "action-cancel": {
      const payload = message.payload || {};
      pendingActions.get(JSON.stringify([payload.id, payload.generation, payload.actionId]))?.cancel();
      break;
    }
    case "action":
      handleAction(message.payload || message, true);
      break;
    case "create":
      createSession(message.payload);
      break;

    case "attach": {
      const payload = message.payload || {};
      const session = sessions.get(payload.id);
      if (!matchesSession(session, payload)) break;
      if (session.terminal && (payload.cols || payload.rows)) {
        const cols = Math.max(20, Number(payload.cols || session.cols));
        const rows = Math.max(6, Number(payload.rows || session.rows));
        if (cols !== session.cols || rows !== session.rows) {
          session.terminal.resize(cols, rows);
          session.cols = cols; session.rows = rows;
          session.history.resize(cols, rows);
          emit({ id: payload.id, type: "resize", generation: session.generation, cols, rows });
        }
      }
      emitSnapshot(payload.id, session);
      break;
    }

    case "input": {
      if (message.payload.actionId) { handleAction({ ...message.payload, kind: "input" }, false); break; }
      const session = sessions.get(message.payload.id);
      if (session?.terminal && matchesSession(session, message.payload)) {
        noteManualInput(session, message.payload.data);
        session.terminal.write(message.payload.data);
      }
      break;
    }

    case "resize": {
      const session = sessions.get(message.payload.id);
      if (session?.terminal && matchesSession(session, message.payload)) {
        const cols = Math.max(20, Number(message.payload.cols || 100));
        const rows = Math.max(6, Number(message.payload.rows || 28));
        if (session.cols !== cols || session.rows !== rows) {
          session.terminal.resize(cols, rows);
          session.cols = cols;
          session.rows = rows;
          session.history.resize(cols, rows);
          emit({ id: message.payload.id, type: "resize", generation: session.generation, cols, rows });
          debug({ type: "resize", id: message.payload.id, cols, rows });
        } else {
          debug({ type: "resize-skipped", id: message.payload.id, cols, rows });
        }
      }
      break;
    }

    case "stop-observed": {
      void stopObserver.stop(message.payload, () => {
        const session = sessions.get(message.payload.id);
        if (matchesSession(session, message.payload)) {
          cancelSessionSubmission(session);
          disposeSession(session);
          sessions.delete(message.payload.id);
        }
      });
      break;
    }
    case "kill": {
      if (message.payload.actionId) { handleAction({ ...message.payload, kind: "kill" }, false); break; }
      const session = sessions.get(message.payload.id);
      if (matchesSession(session, message.payload)) {
        cancelSessionSubmission(session);
        if (session.terminal) {
          session.terminal.kill();
        }
        disposeSession(session);
        sessions.delete(message.payload.id);
      }
      break;
    }

    case "shutdown":
      sessions.forEach((session) => { cancelSessionSubmission(session); session.terminal?.kill(); disposeSession(session); });
      sessions.clear();
      process.exit(0);
      break;

    default:
      emit({
        type: "host-error",
        message: `Unknown PTY host message: ${message.type}`
      });
  }
}

// Keep the draft and the one final Enter inside one reserved host action. Native
// composers can treat Enter in the paste write as pasted content. A short gap
// lets their input parser finish; it does not prove that the agent starts work.
function stageNativeSubmission(payload, session, data, submitData, resultKey, result) {
  const terminal = session.terminal, revision = session.inputRevision;
  const owner = session.ownerRequestId, cols = session.cols, rows = session.rows;
  const deadlineAt = payload.deadlineAt ?? Date.now() + 15000;
  let timer, finished = false;
  const finish = (ok, error) => {
    if (finished) return;
    finished = true; clearTimeout(timer); pendingActions.delete(resultKey);
    if (ok) {
      session.manualInputPending = false; session.interactionInputPending = false; session.ownerRequestId = null;
      emit({ type: 'input-state', id: session.id, generation: session.generation, ...inputState(session) });
      result(true, 'written');
    } else result(false, 'unknown', error, { submission: 'unconfirmed', partialWrite: true });
  };
  const cancel = () => finish(false, 'Submission cancelled after text may have reached the terminal. Text may remain in the composer; no automatic Enter or retry.');
  pendingActions.set(resultKey, { id: payload.id, session, cancel });
  try { terminal.write(data); }
  catch (error) { finish(false, error.message); return; }
  timer = setTimeout(() => {
    if (finished) return;
    if (Date.now() >= deadlineAt || sessions.get(payload.id) !== session || !matchesSession(session, payload) || session.terminal !== terminal ||
        session.inputRevision !== revision || session.ownerRequestId !== owner || !session.interactionInputPending ||
        session.manualInputPending || session.cols !== cols || session.rows !== rows || session.launchPending) return cancel();
    try { process.kill(payload.expectedAgentPid, 0); }
    catch { return finish(false, 'The native recipient exited after text was staged. Text may remain in the composer; submission is unconfirmed.'); }
    try { terminal.write(submitData); finish(true); }
    catch (error) { finish(false, error.message); }
  }, NATIVE_SUBMIT_DELAY_MS);
}

function handleAction(payload, strict) {
  const resultKey = JSON.stringify([payload.id, payload.generation, payload.actionId]);
  if (pendingActions.has(resultKey)) return; // The original action owns the pending acknowledgment.
  if (payload.actionId && checkedResults.has(resultKey)) { emit(checkedResults.get(resultKey)); return; }
  const result = (ok, status, error, extra = {}) => {
    const event = { type: "action-result", actionId: payload.actionId, id: payload.id, generation: payload.generation, ok, status, ...(status === "written" ? { delivery: "pty-transport-only" } : !ok && !['unknown', 'write-failed'].includes(status) ? { delivery: 'not-dispatched' } : {}), ...(error ? { error } : {}), ...extra };
    if (payload.actionId) { checkedResults.set(resultKey, event); if (checkedResults.size > 1000) checkedResults.delete(checkedResults.keys().next().value); }
    emit(event);
  };
  if (!payload.actionId || !payload.id || (strict && (payload.generation === undefined || payload.generation === null))) return result(false, "invalid-action", "Action ID, session ID and generation are required.");
  if (!["input", "interaction", "interrupt", "kill"].includes(payload.kind)) return result(false, "invalid-action", "Unknown terminal action.");
  const session = sessions.get(payload.id);
  if (!matchesSession(session, payload)) return result(false, "stale-generation", "The terminal generation is no longer current.");
  if (!session.terminal) return result(false, "not-running", "The terminal has exited.");
  if (["interrupt", "kill"].includes(payload.kind)) cancelSessionSubmission(session);
  if ([...pendingActions.values()].some(entry => entry.id === payload.id)) return result(false, "interaction-busy", "Another terminal submission is in flight.");
  if (payload.deadlineAt !== undefined && (!Number.isFinite(payload.deadlineAt) || Date.now() >= payload.deadlineAt)) return result(false, "cancelled", "Cancelled before terminal input deadline.");
  if (session.launchPending && ["input", "interaction"].includes(payload.kind)) return result(false, "launch-pending", "The terminal launcher has not been submitted yet. Wait for startup before sending input.");
  if (payload.kind === "input" && typeof payload.data !== "string") return result(false, "invalid-action", "Input must be a string.");
  try {
    if (payload.kind === "interaction") {
      const evidence = payload.interactionEvidence, pid = payload.expectedAgentPid;
      const age = Date.now() - Number(evidence?.observedAt);
      if (payload.generation == null || !Number.isSafeInteger(pid) || pid <= 0 || evidence?.id !== payload.id || evidence?.generation !== session.generation || evidence?.pid !== pid || !Number.isSafeInteger(evidence?.sequence) || evidence.sequence !== session.sequence || !Number.isFinite(age) || age < 0 || age > 5000 || (evidence.shell && pid !== session.terminal.pid)) return result(false, "stale-observation", "Fresh generation-bound terminal interaction evidence is required.");
      if (!Number.isSafeInteger(evidence.cols) || evidence.cols !== session.cols || !Number.isSafeInteger(evidence.rows) || evidence.rows !== session.rows) return result(false, "stale-observation", "The terminal geometry changed after the last observation.");
      try { process.kill(pid, 0); } catch { return result(false, "recipient-unavailable", "The expected input recipient is no longer alive."); }
      const freshInput = Number.isSafeInteger(evidence.inputRevision) && evidence.inputRevision === session.inputRevision;
      if ((payload.operator || payload.editInput || evidence.inputRevision !== undefined) && !freshInput) return result(false, "stale-observation", "Read the current terminal input revision before interacting.");
      if (payload.operator && (typeof payload.requestId !== 'string' || !payload.requestId)) return result(false, "invalid-action", "Operator controls require a request owner.");
      const encoded = encodeTerminalControls(payload, session);
      if (!encoded.ok) return result(false, encoded.status || "invalid-action", encoded.error);
      if (session.manualInputPending && !payload.editInput) return result(false, "input-buffer-occupied", "This terminal may contain unsent user input.");
      if (session.interactionInputPending && session.ownerRequestId !== (payload.requestId || null) && !payload.editInput) return result(false, "input-buffer-occupied", "Another request owns the staged terminal input.");
      if (session.heldMouseButton && session.mouseOwnerRequestId !== (payload.requestId || null) && !payload.editInput) return result(false, "input-buffer-occupied", "Another request owns the held mouse button.");
      if (session.heldMouseButton && payload.mouse && !payload.mouse.button.startsWith('wheel-') && payload.mouse.button !== session.heldMouseButton) return result(false, 'invalid-action', 'Release the currently held mouse button before using another button.');
      // Reserve before the write: a throwing transport may already have consumed
      // bytes. Its input revision and lease cannot be reused after uncertainty.
      const submitted = payload.submit || payload.keys?.some(key => ['enter', 'ctrl-m', 'ctrl-j'].includes(key));
      const changedDraft = Boolean(encoded.text || payload.keys?.some(key => !['enter', 'escape', 'ctrl-c'].includes(key)));
      if (payload.editInput) {
        session.manualInputPending = false;
        if (session.interactionInputPending) session.ownerRequestId = payload.requestId || null;
        if (session.heldMouseButton) session.mouseOwnerRequestId = payload.requestId || null;
      }
      if (changedDraft) { session.interactionInputPending = true; session.ownerRequestId = payload.requestId || null; }
      if (payload.mouse && ['down', 'move'].includes(payload.mouse.action)) {
        session.heldMouseButton = payload.mouse.button; session.mouseOwnerRequestId = payload.requestId || null;
      }
      inputChanged(session);
      if (encoded.text && submitted && !evidence.shell) {
        return stageNativeSubmission(payload, session, encoded.data.slice(0, -1), encoded.data.slice(-1), resultKey, result);
      }
      session.terminal.write(encoded.data);
      if (payload.mouse && ['up', 'click'].includes(payload.mouse.action) && payload.mouse.button === session.heldMouseButton) {
        session.heldMouseButton = null; session.mouseOwnerRequestId = null;
        emit({ type: 'input-state', id: session.id, generation: session.generation, ...inputState(session) });
      }
      if (submitted || payload.keys?.includes('ctrl-c')) {
        session.manualInputPending = false; session.interactionInputPending = false; session.ownerRequestId = null;
        emit({ type: 'input-state', id: session.id, generation: session.generation, ...inputState(session) });
      }
      return result(true, "written"); // ConPTY acceptance, not foreground ownership or answer consumption.
    }
    if (payload.expectedAgentPid !== undefined) {
      const pid = Number(payload.expectedAgentPid);
      if (!Number.isSafeInteger(pid) || pid <= 0) return result(false, "invalid-action", "Invalid expected agent PID.");
      // A live child PID does not establish ownership of a shell's foreground
      // input surface. ConPTY/node-pty exposes no atomic recipient-bound write.
      // Main may authorize best-effort delivery from freshly checked stable idle
      // evidence. This is still transport acceptance, not agent consumption.
      const evidence = payload.recipientEvidence;
      const age = Date.now() - Number(evidence?.observedAt);
      const idleEvidence = evidence && evidence.generation === session.generation &&
        evidence.pid === pid && evidence.state === "idle" && Number.isFinite(age) && age >= 0 && age <= 5000;
      try { process.kill(pid, 0); } catch { return result(false, "recipient-unavailable", "The expected agent process cannot be confirmed alive."); }
      if (payload.kind !== "kill" && !idleEvidence) return result(false, "input-surface-unverified", "Fresh generation-bound idle evidence is required for guarded PTY input.");
    }
    let data = payload.data;
    if (payload.kind === "input" && payload.promptText !== undefined) {
      if (typeof payload.promptText !== "string" || !payload.promptText.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(payload.promptText)) return result(false, "invalid-action", "Prompt contains unsupported control characters or is empty.");
      if (session.manualInputPending || session.interactionInputPending || session.heldMouseButton) return result(false, "input-buffer-occupied", "This terminal may contain unsent user input. Prompt preserved as a draft without changing that input.");
      if (payload.expectedAgentPid !== undefined) {
        if (/[\r\n]/.test(payload.promptText) && !session.bracketedPaste) return result(false, "needs-staging", "This agent has not enabled bracketed paste; multiline prompt preserved for review.");
        data = session.bracketedPaste ? "\x1b[200~" + payload.promptText.replace(/\r\n?/g, "\n") + "\x1b[201~\r" : payload.promptText + "\r";
      } else data = payload.promptText + "\r";
    }
    if (payload.kind === "kill") {
      session.terminal.kill();
      disposeSession(session);
      sessions.delete(payload.id);
      return result(true, "kill-requested");
    }
    if (payload.kind === "interrupt") noteManualInput(session, "\x03");
    else if (payload.promptText === undefined) noteManualInput(session, data);
    if (payload.promptText !== undefined) {
      session.interactionInputPending = true; session.ownerRequestId = payload.requestId || null;
      inputChanged(session);
      if (payload.expectedAgentPid !== undefined) return stageNativeSubmission(payload, session, data.slice(0, -1), data.slice(-1), resultKey, result);
    }
    session.terminal.write(payload.kind === "interrupt" ? "\x03" : data);
    if (payload.promptText !== undefined) {
      session.interactionInputPending = false; session.ownerRequestId = null;
      emit({ type: 'input-state', id: session.id, generation: session.generation, ...inputState(session) });
    }
    return result(true, "written"); // Transport acceptance, never agent completion.
  } catch (error) {
    return result(false, payload.kind === "interaction" ? "unknown" : "write-failed", error.message);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  try {
    handleMessage(JSON.parse(line));
  } catch (error) {
    emit({
      type: "host-error",
      message: `Bad PTY host message: ${error.message}`
    });
  }
});

emit({ type: "ready" });
