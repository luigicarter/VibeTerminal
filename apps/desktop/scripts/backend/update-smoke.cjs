const assert = require("assert");
const fs = require("fs");
const path = require("path");

const mainPath = path.join(__dirname, "..", "..", "backend", "main.cjs");
const readmePath = path.join(__dirname, "..", "..", "README.md");
const windowsReleasePath = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "windows-release.md"
);
const packagePath = path.join(__dirname, "..", "..", "package.json");
const installerNshPath = path.join(
  __dirname,
  "..",
  "..",
  "build",
  "installer.nsh"
);

const mainSource = fs.readFileSync(mainPath, "utf8");
const readmeSource = fs.readFileSync(readmePath, "utf8");
const windowsReleaseSource = fs.readFileSync(windowsReleasePath, "utf8");
const packageSource = fs.readFileSync(packagePath, "utf8");
const installerNshSource = fs.readFileSync(installerNshPath, "utf8");

assert(
  mainSource.includes("updater.autoDownload = false") &&
    mainSource.includes("updater.autoInstallOnAppQuit = false"),
  "updates should remain user-initiated and avoid surprise terminal interruption"
);

assert(
  mainSource.includes("currentVersion: app.getVersion()"),
  "update state should expose the current app version to the renderer"
);

assert(
  mainSource.includes("getAutoUpdater().quitAndInstall(true, true)") &&
    !mainSource.includes("quitAndInstall(false, true)"),
  "Windows updates should install silently and relaunch after explicit restart"
);

assert(
  readmeSource.includes("installer runs silently") &&
    windowsReleaseSource.includes("quitAndInstall(true, true)") &&
    windowsReleaseSource.includes("installer UI should not appear"),
  "update documentation should describe silent Windows install behavior"
);

assert(
  /\$\{if\}\s*\$\{isUpdated\}/.test(installerNshSource) &&
    /SetSilent\s+silent/.test(installerNshSource),
  "NSIS installer should force silent mode for updates while keeping the first-install wizard"
);

assert(
  packageSource.includes('"include": "build/installer.nsh"'),
  "electron-builder NSIS config should wire up the custom installer hook"
);

function updateHarness({ packaged = true, checkError, downloadError } = {}) {
  const vm = require("vm");
  const { EventEmitter } = require("events");
  const states = [];
  const restarts = [];
  const pendingRestarts = [];
  const handlers = new Map();
  const updater = new EventEmitter();
  let downloads = 0;
  updater.checkForUpdates = async () => {
    updater.emit("checking-for-update");
    if (checkError) throw new Error(checkError);
    updater.emit("update-available", { version: "1.2.3" });
  };
  updater.downloadUpdate = async () => {
    downloads++;
    if (downloadError) throw new Error(downloadError);
    updater.emit("download-progress", { percent: 50, transferred: 5, total: 10 });
    updater.emit("update-downloaded", { version: "1.2.3" });
  };
  updater.quitAndInstall = (...args) => restarts.push(args);
  const context = {
    app: { isPackaged: packaged },
    autoUpdaterConfigured: false,
    checkedForUpdatesOnLaunch: false,
    updateDownloadRequested: false,
    manualUpdateCheckRequested: false,
    updateState: { status: "idle", currentVersion: "1.2.2" },
    getAutoUpdater: () => updater,
    BrowserWindow: { getAllWindows: () => [{ webContents: {
      send: (channel, state) => {
        assert.strictEqual(channel, "updates:event");
        states.push(state);
      }
    } }] },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    setImmediate: (callback) => pendingRestarts.push(callback),
    console: { error() {} }
  };
  vm.createContext(context);
  const start = mainSource.indexOf("function serializeUpdateInfo(");
  const end = mainSource.indexOf("\nasync function findLatestAgentThread(", start);
  assert(start >= 0 && end > start);
  vm.runInContext(mainSource.slice(start, end), context);
  const ipcStart = mainSource.indexOf('ipcMain.handle("updates:get-state",');
  const ipcEnd = mainSource.indexOf('\nipcMain.handle("workspace:select-folder",', ipcStart);
  assert(ipcStart >= 0 && ipcEnd > ipcStart);
  vm.runInContext(mainSource.slice(ipcStart, ipcEnd), context);
  assert.deepStrictEqual([...handlers.keys()].sort(), [
    "updates:check", "updates:download", "updates:get-state", "updates:restart"
  ]);
  return { context, updater, states, restarts, pendingRestarts,
    downloads: () => downloads, invoke: (channel) => handlers.get(channel)() };
}

(async () => {
  const flow = updateHarness();
  assert.strictEqual(flow.invoke("updates:restart"), false);
  assert.strictEqual((await flow.invoke("updates:download")).ok, false);
  assert.strictEqual((await flow.invoke("updates:check")).ok, true);
  assert.strictEqual(flow.invoke("updates:get-state").status, "available");
  assert.strictEqual(flow.downloads(), 0, "checking must not start a download");
  assert.strictEqual(flow.updater.autoDownload, false);
  assert.strictEqual(flow.updater.autoInstallOnAppQuit, false);
  assert.strictEqual((await flow.invoke("updates:download")).ok, true);
  assert.strictEqual(flow.invoke("updates:get-state").status, "downloaded");
  assert.strictEqual(flow.invoke("updates:get-state").info.version, "1.2.3");
  assert(flow.states.some(state => state.progress?.percent === 50));
  assert.strictEqual(flow.pendingRestarts.length, 0, "downloading must not restart");
  assert.strictEqual((await flow.invoke("updates:download")).ok, true);
  assert.strictEqual(flow.downloads(), 1, "a staged update must not download again");
  assert.strictEqual(flow.invoke("updates:restart"), true);
  assert.strictEqual(flow.pendingRestarts.length, 1);
  flow.pendingRestarts[0]();
  assert.deepStrictEqual(flow.restarts, [[true, true]]);

  const failedCheck = updateHarness({ checkError: "network unavailable" });
  assert.strictEqual((await failedCheck.invoke("updates:check")).ok, false);
  assert.strictEqual(failedCheck.invoke("updates:get-state").status, "error");
  assert.strictEqual(failedCheck.context.manualUpdateCheckRequested, false);
  const launchCheck = updateHarness({ checkError: "network unavailable" });
  await launchCheck.context.checkForUpdatesOnLaunch();
  assert.strictEqual(launchCheck.invoke("updates:get-state").status, "idle");

  const failedDownload = updateHarness({ downloadError: "download interrupted" });
  await failedDownload.invoke("updates:check");
  assert.strictEqual((await failedDownload.invoke("updates:download")).ok, false);
  assert.strictEqual(failedDownload.invoke("updates:get-state").status, "error");
  assert.strictEqual(failedDownload.invoke("updates:restart"), false);
  assert.strictEqual(failedDownload.pendingRestarts.length, 0);

  const development = updateHarness({ packaged: false });
  assert.strictEqual((await development.invoke("updates:check")).ok, false);
  assert.strictEqual(development.invoke("updates:get-state").status, "disabled");
  assert.strictEqual((await development.invoke("updates:download")).ok, false);
  assert.strictEqual(development.invoke("updates:restart"), false);
  console.log("update smoke passed (check, download, explicit restart, failures and IPC surface)");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
