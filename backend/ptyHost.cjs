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

    if (existingSession?.terminal && (payload.cols || payload.rows)) {
      existingSession.terminal.resize(
        Math.max(20, Number(payload.cols || 100)),
        Math.max(6, Number(payload.rows || 28))
      );
    }

    if (existingSession) {
      emitSnapshot(payload.id, existingSession);
    }

    return;
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
        if (sessions.has(payload.id)) {
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
        session.terminal.resize(
          Math.max(20, Number(message.payload.cols || 100)),
          Math.max(6, Number(message.payload.rows || 28))
        );
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
