const { spawn, spawnSync } = require("child_process");
const http = require("http");
const path = require("path");

const isWindows = process.platform === "win32";
const rootDir = path.join(__dirname, "..", "..");
const npmCmd = isWindows ? "npm.cmd" : "npm";
const electronBin = path.join(
  rootDir,
  "node_modules",
  ".bin",
  isWindows ? "electron.cmd" : "electron"
);
const rendererCommand = isWindows ? `${npmCmd} run dev:frontend` : npmCmd;
const rendererArgs = isWindows ? [] : ["run", "dev:frontend"];
const electronCommand = isWindows ? `"${electronBin}" .` : electronBin;
const electronArgs = isWindows ? [] : ["."];

function killTree(child) {
  if (!child || child.killed) {
    return;
  }

  if (isWindows && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore"
    });
    return;
  }

  child.kill();
}

function waitForRenderer(url, timeoutMs = 30000) {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });

      req.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }

        setTimeout(tick, 250);
      });
    };

    tick();
  });
}

async function main() {
  const renderer = spawn(rendererCommand, rendererArgs, {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
    shell: isWindows
  });

  const shutdown = () => {
    killTree(renderer);
  };

  process.on("exit", shutdown);
  process.on("SIGINT", () => {
    shutdown();
    process.exit(130);
  });

  await waitForRenderer("http://127.0.0.1:5173");

  const app = spawn(electronCommand, electronArgs, {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
    },
    shell: isWindows
  });

  app.on("exit", (code) => {
    shutdown();
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
