// Fusion adapter MCP-surface smoke test.
//
// Spawns backend/fusion-adapter.cjs and drives its north (MCP stdio) side the
// way Claude Code would: `initialize` then `tools/list`. Asserts the hand-rolled
// MCP server identifies itself and exposes the two Fusion tools. This guards the
// riskiest hand-written piece without needing codex auth or a model turn (the
// full app-server turn round-trip is covered by the end-to-end check).

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const adapterPath = path.join(__dirname, "..", "..", "backend", "fusion-adapter.cjs");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const child = spawn(process.execPath, [adapterPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // A dummy endpoint: the adapter connects lazily (only on a tool call), so
      // the MCP surface is exercised without a live app-server.
      VIBE_TERMINAL_FUSION_WS: "ws://127.0.0.1:1",
      VIBE_TERMINAL_SESSION_ID: "fusion-adapter-smoke"
    }
  });

  const responses = new Map();
  let buffer = "";

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for MCP responses"));
    }, 10000);

    function cleanup() {
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // ignore
      }
    }

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (responses.has(1) && responses.has(2)) {
          try {
            const init = responses.get(1);
            assert(
              init.result && init.result.serverInfo && init.result.serverInfo.name === "fusion-codex",
              `initialize did not identify the fusion adapter: ${JSON.stringify(init)}`
            );
            assert(
              init.result.capabilities && init.result.capabilities.tools,
              "initialize did not advertise tools capability"
            );
            const list = responses.get(2);
            const names = (list.result && list.result.tools ? list.result.tools : []).map(
              (t) => t.name
            );
            assert(names.includes("codex_implement"), "tools/list missing codex_implement");
            assert(names.includes("codex_respond"), "tools/list missing codex_respond");
            const source = fs.readFileSync(adapterPath, "utf8");
            assert(source.includes('notify("initialized")'), "adapter does not send initialized notification");
            assert(source.includes("PARKED_REQUEST_METHODS"), "adapter does not allowlist parked request methods");
            assert(source.includes('method === "currentTime/read"'), "adapter does not handle currentTime/read");
            assert(source.includes("unsupportedServerRequest"), "adapter does not fail unsupported server requests explicitly");
            cleanup();
            resolve();
          } catch (error) {
            cleanup();
            reject(error);
          }
        }
      }
    });

    // Drive the MCP handshake.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fusion-adapter-smoke", version: "0.0.0" }
        }
      })}\n`
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  });
}

main()
  .then(() => {
    console.log("Fusion adapter smoke passed");
  })
  .catch((error) => {
    console.error(`FAIL fusion-adapter-smoke: ${error.message}`);
    process.exit(1);
  });
