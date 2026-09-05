const readline = require("readline");

let pty = null;
try {
  pty = require("node-pty");
} catch (error) {
  emit({
    type: "host-error",
    message: `node-pty could not be loaded: ${error.message}`
  });
}

const sessions = new Map();
const checkedResults = new Map();
const MAX_SESSION_BUFFER_CHARS = 400_000;

function emit(event) {
  process.stdout.write(`${JSON.stringify({ at: Date.now(), ...event })}\n`);
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
    TERM_PROGRAM: "vibeTerminal",
    ...instrumentationEnv
  };
}

function appendSessionBuffer(session, data) {
  session.buffer += data;

  if (session.buffer.length > MAX_SESSION_BUFFER_CHARS) {
    session.buffer = session.buffer.slice(-MAX_SESSION_BUFFER_CHARS);
  }
}

function emitSnapshot(id, session) {
  emit({
    id,
    type: "snapshot",
    data: session.buffer,
    isRunning: Boolean(session.terminal),
    launchToken: session.launchToken,
    generation: session.generation,
    terminalTitle: session.terminalTitle,
    exitCode: session.exitCode,
    signal: session.signal,
    cols: session.cols, rows: session.rows, sequence: session.sequence, outputAt: session.outputAt
  });
}

function matchesSession(session, payload) {
  return Boolean(session) &&
    (payload.generation === undefined || payload.generation === session.generation) &&
    (payload.launchToken === undefined || Number(payload.launchToken) === session.launchToken);
}

// Conservative "user may have an unsent draft" marker, not a reconstruction
// of a provider editor. Output never clears it; arrow/tab input can dirty it.
function noteManualInput(session, data) {
  if (typeof data !== "string" || !data) return;
  // xterm emits these replies through onData without a user editing anything.
  // Match whole packets only; navigation/paste and mixed packets stay dirty.
  if (/^\x1b\[(?:[IO]|\??\d+;\d+R|[?>][0-9]+(?:;[0-9]+)*c|[03]n)$/.test(data)) return;
  session.manualInputPending = !["\r", "\n", "\r\n", "\x03"].includes(data);
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

function createSession(payload) {
  debug({
    type: "create",
    id: payload.id,
    command: payload.command,
    cwd: payload.cwd,
    launchToken: payload.launchToken,
    cols: payload.cols,
    rows: payload.rows
  });

  if (!pty) {
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
      existingSession?.terminal?.kill();
      sessions.delete(payload.id);
    } else {
      if (existingSession?.terminal && (payload.cols || payload.rows)) {
        const cols = Math.max(20, Number(payload.cols || 100));
        const rows = Math.max(6, Number(payload.rows || 28));
        if (existingSession.cols !== cols || existingSession.rows !== rows) {
          existingSession.terminal.resize(cols, rows);
          existingSession.cols = cols;
          existingSession.rows = rows;
          emit({ id: payload.id, type: "resize", generation: existingSession.generation, cols, rows });
          debug({ type: "dedup-resize", id: payload.id, cols, rows });
        } else {
          debug({ type: "dedup-resize-skipped", id: payload.id, cols, rows });
        }
      }

      if (existingSession) {
        emitSnapshot(payload.id, existingSession);
      }

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
    terminal: null,
    buffer: "",
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
    const terminal = pty.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: terminalEnvironment(instrumentationEnv, instrumentationStripEnv)
    });

    session.terminal = terminal;
    sessions.set(payload.id, session);
    emit({ id: payload.id, type: "created", generation: session.generation, launchToken: session.launchToken, cols, rows, pid: terminal.pid });

    terminal.onData((data) => {
      if (sessions.get(payload.id) !== session) {
        return;
      }

      appendSessionBuffer(session, data);
      const modeText = session.modeTail + data;
      const modes = /\x1b\[\?([0-9;]+)([hl])/g;
      for (const match of modeText.matchAll(modes)) if (match[1].split(";").includes("2004")) session.bracketedPaste = match[2] === "h";
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

    terminal.onExit(({ exitCode, signal }) => {
      const currentSession = sessions.get(payload.id);
      if (currentSession !== session) {
        return;
      }

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
          terminal.write(`${payload.command}${lineEnding}`);
        }
      }, 250);
    }
  } catch (error) {
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
    case "action":
      handleAction(message.payload || message, true);
      break;
    case "create":
      createSession(message.payload);
      break;

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
          emit({ id: message.payload.id, type: "resize", generation: session.generation, cols, rows });
          debug({ type: "resize", id: message.payload.id, cols, rows });
        } else {
          debug({ type: "resize-skipped", id: message.payload.id, cols, rows });
        }
      }
      break;
    }

    case "kill": {
      if (message.payload.actionId) { handleAction({ ...message.payload, kind: "kill" }, false); break; }
      const session = sessions.get(message.payload.id);
      if (matchesSession(session, message.payload)) {
        if (session.terminal) {
          session.terminal.kill();
        }
        sessions.delete(message.payload.id);
      }
      break;
    }

    case "shutdown":
      sessions.forEach((session) => session.terminal?.kill());
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

function handleAction(payload, strict) {
  const resultKey = JSON.stringify([payload.id, payload.generation, payload.actionId]);
  if (payload.actionId && checkedResults.has(resultKey)) { emit(checkedResults.get(resultKey)); return; }
  const result = (ok, status, error) => {
    const event = { type: "action-result", actionId: payload.actionId, id: payload.id, generation: payload.generation, ok, status, ...(status === "written" ? { delivery: "pty-transport-only" } : {}), ...(error ? { error } : {}) };
    if (payload.actionId) { checkedResults.set(resultKey, event); if (checkedResults.size > 1000) checkedResults.delete(checkedResults.keys().next().value); }
    emit(event);
  };
  if (!payload.actionId || !payload.id || (strict && (payload.generation === undefined || payload.generation === null))) return result(false, "invalid-action", "Action ID, session ID and generation are required.");
  if (!["input", "interrupt", "kill"].includes(payload.kind)) return result(false, "invalid-action", "Unknown terminal action.");
  const session = sessions.get(payload.id);
  if (!matchesSession(session, payload)) return result(false, "stale-generation", "The terminal generation is no longer current.");
  if (!session.terminal) return result(false, "not-running", "The terminal has exited.");
  if (payload.kind === "input" && typeof payload.data !== "string") return result(false, "invalid-action", "Input must be a string.");
  try {
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
      if (session.manualInputPending) return result(false, "input-buffer-occupied", "This terminal may contain unsent user input. Prompt preserved as a draft without changing that input.");
      if (payload.expectedAgentPid !== undefined) {
        if (/[\r\n]/.test(payload.promptText) && !session.bracketedPaste) return result(false, "needs-staging", "This agent has not enabled bracketed paste; multiline prompt preserved for review.");
        data = session.bracketedPaste ? "\x1b[200~" + payload.promptText.replace(/\r\n?/g, "\n") + "\x1b[201~\r" : payload.promptText + "\r";
      } else data = payload.promptText + "\r";
    }
    if (payload.kind === "kill") {
      session.terminal.kill();
      sessions.delete(payload.id);
      return result(true, "kill-requested");
    }
    if (payload.kind === "interrupt") noteManualInput(session, "\x03");
    else if (payload.promptText === undefined) noteManualInput(session, data);
    session.terminal.write(payload.kind === "interrupt" ? "\x03" : data);
    return result(true, "written"); // Transport acceptance, never agent completion.
  } catch (error) {
    return result(false, "write-failed", error.message);
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
