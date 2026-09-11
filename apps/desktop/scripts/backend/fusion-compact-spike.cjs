#!/usr/bin/env node
// Manual-run spike (costs tokens, needs claude auth — NOT wired into CI):
// does the Claude Code CLI honor "/compact" sent as a stream-json user
// message in a --print --input-format stream-json session?
//
// Probe: (1) plant a codeword, (2) send "/compact", (3) ask for the codeword
// back. PASS needs a compact-shaped system signal in (2) — or a silent
// history rewrite corroborated by (3)'s input-token drop — plus codeword
// recall and a live process. The verdict gates whether Fusion gets a real
// /compact command or the ctx% fallback indicator (see the plan).
//
// Usage: node scripts/backend/fusion-compact-spike.cjs
//   VIBE_SPIKE_CLAUDE_MODEL=haiku (default) overrides the probe model.

const os = require("os");
const { spawn } = require("child_process");
const { buildClaudeSpawn } = require("../../backend/fusionChatHost.cjs");

const MODEL = process.env.VIBE_SPIKE_CLAUDE_MODEL || "haiku";
const TURN_TIMEOUT_MS = 120_000;
const HARD_KILL_MS = 360_000;
const CODEWORD = "BLUEBIRD-7342";

function userMessage(text) {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] }
  })}\n`;
}

async function main() {
  const { command, args } = buildClaudeSpawn({
    model: MODEL,
    permissionMode: "default"
  });
  console.log(`[spike] spawning: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: os.tmpdir(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  const hardKill = setTimeout(() => {
    console.log("[spike] hard kill after 6 minutes");
    child.kill();
  }, HARD_KILL_MS);

  let buffer = "";
  const lines = [];
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      console.log(`[stdout] ${line}`);
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      const entry = { raw: line, json: parsed };
      lines.push(entry);
      for (const waiter of [...waiters]) {
        if (waiter.match(entry)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(entry);
        }
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log(`[stderr] ${text}`);
  });

  let exited = false;
  child.on("exit", (code) => {
    exited = true;
    console.log(`[spike] child exited (${code})`);
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  });

  function waitFor(match, timeoutMs) {
    return new Promise((resolve) => {
      const waiter = { match, resolve };
      waiter.timer = setTimeout(() => {
        const at = waiters.indexOf(waiter);
        if (at !== -1) waiters.splice(at, 1);
        resolve(null);
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  const isResult = (entry) => entry.json && entry.json.type === "result";
  const usageOf = (entry) => {
    const usage =
      (entry && entry.json && (entry.json.usage || (entry.json.message && entry.json.message.usage))) ||
      null;
    return usage && typeof usage === "object" ? usage : null;
  };
  const inputTokensOf = (usage) =>
    usage
      ? Number(usage.input_tokens || 0) +
        Number(usage.cache_read_input_tokens || 0) +
        Number(usage.cache_creation_input_tokens || 0)
      : 0;

  // Turn 1: plant the codeword.
  const turn1Mark = lines.length;
  child.stdin.write(
    userMessage(`Remember this codeword: ${CODEWORD}. Reply with exactly: OK`)
  );
  const result1 = await waitFor(isResult, TURN_TIMEOUT_MS);
  if (!result1) {
    console.log("COMPACT SPIKE: FAIL — turn 1 never produced a result (auth/model problem?)");
    child.kill();
    clearTimeout(hardKill);
    return;
  }
  const turn1Input = inputTokensOf(usageOf(result1));

  // Turn 2: send /compact as a plain user message.
  const turn2Mark = lines.length;
  child.stdin.write(userMessage("/compact"));
  // A compact may or may not end with a result — wait for EITHER a
  // compact-shaped system line or a result, then let the tail settle.
  const compactish = (entry) =>
    (entry.json &&
      entry.json.type === "system" &&
      /compact/i.test(String(entry.json.subtype || ""))) ||
    isResult(entry);
  await waitFor(compactish, TURN_TIMEOUT_MS);
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  const turn2Lines = lines.slice(turn2Mark);
  // Observed live (claude 2.1.200): the CLI interprets "/compact" and emits
  //   {"type":"system","subtype":"status","status":"compacting"}
  //   {"type":"system","subtype":"status","status":null,"compact_result":"failed",
  //    "compact_error":"Not enough messages to compact."}
  // compact_result is "success" on a real compaction; a compact-ish subtype
  // (e.g. compact_boundary) is kept as a forward-compat match.
  const compactSystem = turn2Lines.find(
    (entry) =>
      entry.json &&
      entry.json.type === "system" &&
      (/compact/i.test(String(entry.json.subtype || "")) ||
        String(entry.json.status || "") === "compacting" ||
        "compact_result" in entry.json)
  );
  const compactAnywhere = turn2Lines.find((entry) => /compact/i.test(entry.raw));
  const proseEngage = turn2Lines.find(
    (entry) =>
      entry.json &&
      entry.json.type === "assistant" &&
      /\/compact/.test(JSON.stringify(entry.json.message && entry.json.message.content))
  );

  if (exited) {
    console.log("COMPACT SPIKE: FAIL — child exited after /compact (command not survivable)");
    clearTimeout(hardKill);
    return;
  }

  // Turn 3: recall the codeword; compare input tokens with turn 1.
  child.stdin.write(
    userMessage("What was the codeword? Answer with the codeword only.")
  );
  const turn3Mark = lines.length;
  const result3 = await waitFor(isResult, TURN_TIMEOUT_MS);
  const turn3Lines = lines.slice(turn3Mark);
  const recalled = turn3Lines.some((entry) => entry.raw.includes("BLUEBIRD"));
  const turn3Input = inputTokensOf(usageOf(result3));

  child.stdin.end();
  child.kill();
  clearTimeout(hardKill);

  console.log("[spike] --- evidence ---");
  console.log(`[spike] compact system message: ${compactSystem ? compactSystem.raw : "none"}`);
  console.log(`[spike] any 'compact' in turn-2 output: ${compactAnywhere ? "yes" : "no"}`);
  console.log(`[spike] assistant engaged '/compact' as prose: ${proseEngage ? "yes" : "no"}`);
  console.log(`[spike] codeword recalled after compact: ${recalled ? "yes" : "no"}`);
  console.log(`[spike] input tokens turn1=${turn1Input} turn3=${turn3Input}`);
  void turn1Mark;

  if (compactSystem && recalled) {
    console.log("COMPACT SPIKE: PASS — compact system signal + post-compact recall");
  } else if (!compactSystem && !proseEngage && recalled && turn3Input > 0 && turn3Input < turn1Input) {
    console.log(
      "COMPACT SPIKE: PASS — no explicit signal, but history shrank (silent compact) and recall survived"
    );
  } else if (proseEngage) {
    console.log("COMPACT SPIKE: FAIL — '/compact' reached the model as prose (not interpreted)");
  } else if (!recalled) {
    console.log("COMPACT SPIKE: FAIL — codeword lost (compact destroyed context or session broke)");
  } else {
    console.log("COMPACT SPIKE: FAIL — no compact signal observed");
  }
}

main().catch((error) => {
  console.error(`[spike] harness error: ${error.stack || error.message}`);
  process.exitCode = 1;
});
