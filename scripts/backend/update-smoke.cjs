const assert = require("assert");
const fs = require("fs");
const path = require("path");

const mainPath = path.join(__dirname, "..", "..", "backend", "main.cjs");
const readmePath = path.join(__dirname, "..", "..", "README.md");
const windowsReleasePath = path.join(
  __dirname,
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

console.log("update smoke passed");
