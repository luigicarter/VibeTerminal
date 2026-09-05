"use strict";
const { fork } = require("node:child_process");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const packaged = path.join(root, "release/win-unpacked");
const child = fork(path.join(packaged, "resources/app.asar.unpacked/backend/voiceWakeHost.cjs"), [], {
  execPath: path.join(packaged, "vibeTerminal.exe"), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  windowsHide: true, serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"]
});
let decoded = false, error = "";
child.stderr.on("data", chunk => { error += String(chunk).slice(0, 2000); });
const timeout = setTimeout(() => { child.kill(); console.error("Packaged voice helper timed out.", error); process.exitCode = 1; }, 15000);
child.on("message", message => {
  if (message.type === "ready") child.send({ type: "frames", id: 1, generation: 0, samples: new Float32Array(1280) });
  if (message.type === "result") { assert.equal(message.id, 1); assert.equal(message.found, false); decoded = true; child.send({ type: "dispose" }); }
  if (message.type === "error") { console.error(message); child.kill(); process.exitCode = 1; }
});
child.on("exit", code => { clearTimeout(timeout); if (!decoded || code !== 0) { console.error("Packaged wake helper failed:", error); process.exitCode = 1; } else console.log("Packaged Electron voice helper loaded native runtime/model, decoded silence, and exited cleanly."); });
child.on("error", e => { clearTimeout(timeout); console.error(e.message); process.exitCode = 1; });
child.send({ type: "init", modelPath: path.join(packaged, "resources/voice") });
