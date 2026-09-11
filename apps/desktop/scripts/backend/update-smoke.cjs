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

async function verifyInstallerLaunch(fail) {
  const vm = require("vm");
  const { EventEmitter } = require("events");
  const states = [];
  const timers = [];
  let unreferenced = false;
  const child = new EventEmitter();
  child.unref = () => { unreferenced = true; };
  const context = {
    normalizeReleaseVersion: (value) => value,
    app: { isPackaged: true, getPath: () => "mock-temp", quit() {} },
    versionInstallInFlight: false,
    publishUpdateState: (state) => states.push(state),
    listAppVersions: async () => ({ ok: true, versions: [{
      version: "1.2.3", downloadUrl: "https://example.invalid/installer.exe",
      assetName: "installer.exe"
    }] }),
    path,
    fs: { mkdirSync() {}, createWriteStream: () => new EventEmitter() },
    httpsGet: async () => ({
      headers: {}, on() {}, pipe: (file) => file.emit("finish")
    }),
    spawn: (_file, args, options) => {
      assert.deepStrictEqual(Array.from(args), ["/S", "--force-run"]);
      assert.strictEqual(options.windowsHide, true);
      process.nextTick(() => fail
        ? child.emit("error", new Error("spawn EACCES"))
        : child.emit("spawn"));
      return child;
    },
    setTimeout: (callback, delay) => timers.push({ callback, delay })
  };
  vm.createContext(context);
  const start = mainSource.indexOf("async function installAppVersion(");
  const end = mainSource.indexOf("\nasync function checkForAppUpdates(", start);
  assert(start >= 0 && end > start);
  vm.runInContext(mainSource.slice(start, end), context);
  const result = await context.installAppVersion("1.2.3");
  assert.strictEqual(result.ok, !fail);
  assert.strictEqual(unreferenced, !fail);
  assert.strictEqual(timers.length, fail ? 0 : 1);
  assert.strictEqual(states.at(-1).status, fail ? "error" : "switching");
  if (fail) assert.match(result.message, /EACCES/);
  else assert.strictEqual(timers[0].delay, 1200);
  assert.strictEqual(context.versionInstallInFlight, false);
}

(async () => {
  await verifyInstallerLaunch(true);
  await verifyInstallerLaunch(false);
  console.log("update smoke passed (installer launch failure and success)");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
