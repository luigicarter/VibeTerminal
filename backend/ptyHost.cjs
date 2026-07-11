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
const MAX_SESSION_BUFFER_CHARS = 400_000;

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
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
      args: ["-NoLogo"]
    };
  }

  return {
    file: process.env.SHELL || "bash",
    args: []
  };
}

function terminalEnvironment(instrumentationEnv = {}) {
  const inheritedTerm = process.env.TERM;
  const term =
    !inheritedTerm || inheritedTerm.toLowerCase() === "dumb"
      ? "xterm-256color"
      : inheritedTerm;

  return {
    ...process.env,
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
    exitCode: session.exitCode,
    signal: session.signal
  });
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
      message: "Cannot create terminal because node-pty is unavailable."
    });
    return;
  }

  if (sessions.has(payload.id)) {
    const existingSession = sessions.get(payload.id);
    const incomingToken = Number(payload.launchToken || 0);
    const existingToken = Number(existingSession?.launchToken || 0);

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
  const session = {
    terminal: null,
    buffer: "",
    cols,
    rows,
    launchToken: Number(payload.launchToken || 0),
    exitCode: undefined,
    signal: undefined
  };

  try {
    const terminal = pty.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: terminalEnvironment(instrumentationEnv)
    });

    session.terminal = terminal;
    sessions.set(payload.id, session);

    terminal.onData((data) => {
      if (sessions.get(payload.id) !== session) {
        return;
      }

      appendSessionBuffer(session, data);
      emit({
        id: payload.id,
        type: "data",
        data
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
      message: error.message
    });
  }
}

function handleMessage(message) {
  switch (message.type) {
    case "create":
      createSession(message.payload);
      break;

    case "input": {
      const session = sessions.get(message.payload.id);
      if (session?.terminal) {
        session.terminal.write(message.payload.data);
      }
      break;
    }

    case "resize": {
      const session = sessions.get(message.payload.id);
      if (session?.terminal) {
        const cols = Math.max(20, Number(message.payload.cols || 100));
        const rows = Math.max(6, Number(message.payload.rows || 28));
        if (session.cols !== cols || session.rows !== rows) {
          session.terminal.resize(cols, rows);
          session.cols = cols;
          session.rows = rows;
          debug({ type: "resize", id: message.payload.id, cols, rows });
        } else {
          debug({ type: "resize-skipped", id: message.payload.id, cols, rows });
        }
      }
      break;
    }

    case "kill": {
      const session = sessions.get(message.payload.id);
      if (session) {
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
