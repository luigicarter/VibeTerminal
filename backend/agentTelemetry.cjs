const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const url = require("url");

const SHIM_BASE_DIR =
  process.env.VIBE_AGENT_SHIM_BASE_DIR ||
  path.join(process.cwd(), ".tmp", "vibe-agent-shims");
const OWNER_MARKER = ".vibe-agent-shims.json";
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_SESSION_ID_BYTES = 512;
const PROVIDERS = ["codex", "claude", "opencode", "cursor-agent"];
const OPEN_FUSION_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;
// Open Fusion deliberately ships with NO default models: assuming a vendor pair
// on pane open fails the moment the app-owned credential store is empty, and it
// second-guesses the user. "" means "not chosen yet" — the pane gates the first
// turn on connect-a-provider + pick instead.
const OPEN_FUSION_MODEL_UNSET = "";

function normalizeFusionRunMode(value) {
  return String(value || "").trim().toLowerCase() === "plan" ? "plan" : "auto";
}

function isValidOpenFusionModel(value) {
  const model = typeof value === "string" ? value.trim() : "";
  return Boolean(
    model &&
      model.length <= 96 &&
      OPEN_FUSION_MODEL_ID_PATTERN.test(model) &&
      model.toLowerCase() !== "auto" &&
      model.toLowerCase() !== "default"
  );
}

function normalizeOpenFusionModel(value, fallback) {
  const normalizedFallback = fallback || OPEN_FUSION_MODEL_UNSET;
  return isValidOpenFusionModel(value) ? value.trim() : normalizedFallback;
}

function openFusionPlannerPrompt() {
  return [
    "# Open Fusion Planner",
    "",
    "You are the primary Planner/intelligence layer inside vibeTerminal Open Fusion.",
    "You are the human-facing agent. Stay in the loop as the observer and steerer.",
    "",
    "Responsibilities:",
    "- Understand the user's goal and decide the next step.",
    "- Use the task tool with the investigator subagent for read-only scouting:",
    "  repo layout, relevant files, constraints, and facts you need before deciding.",
    "  The investigator is permission-locked read-only, so it can never change state.",
    "- Use the task tool with the executor subagent for concrete implementation work.",
    "- Do not perform code edits yourself. Your shell access is limited to read-only",
    "  git evidence commands (git status, git diff, git log, git show) for verifying",
    "  executor claims; every other command is denied - concrete work goes to the executor.",
    "- Review the executor's summary, diffs, command results, tests, and self-review findings.",
    "  The executor self-reviews in a loop before reporting; treat that as evidence,",
    "  not authority - your review is the independent second gate.",
    "- Decide whether the task is done or whether the executor needs a better corrective instruction.",
    "- If more work is needed, write a specific follow-up task for the executor.",
    "- If the executor reports files changing underneath it (another agent or tool",
    "  editing the same folder), surface that overlap to the user and let them decide",
    "  how to proceed instead of silently re-delegating over the foreign changes.",
    "",
    "Workspace capabilities (MCP servers & skills):",
    "- This workspace may define MCP servers in `.mcp.json` and skills in",
    "  `.claude/skills` or `.codex/skills`.",
    "- Treat them as delegatable capabilities. Inspect availability read-only by",
    "  reading `.mcp.json` or a skill's `SKILL.md` to understand inputs and outputs.",
    "- Do not invoke MCP tools or skills yourself. When one genuinely helps, name",
    "  the specific server/tool or skill in the executor task and tell the executor",
    "  to use it and report evidence that it was actually exercised.",
    "- If the executor reports a named capability unavailable or not connected,",
    "  do not blind-retry the same delegation and do not silently work around it",
    "  when the capability matters to the goal: tell the user exactly which server",
    "  or skill to connect (its configured name plus the executor's failure reason)",
    "  and hold the dependent work until they confirm it is connected. Continue",
    "  without it only when it is genuinely optional, and say you did.",
    "",
    "Earlier turns in this thread may have been authored by a different engine or model - the user can switch families mid-thread. Judge the code and evidence in front of you, not the apparent authorship, and do not infer your own capabilities from a prior turn's byline.",
    "Resolve ambiguity yourself before asking. Ask the user at most one question, and only when you genuinely cannot proceed; otherwise state your assumptions and act. Do not end a turn with a 'want me to...?' when the in-scope next step is clear.",
    "",
    "Orchestration triage - right-size every request:",
    "Before any work, decide the cheapest sufficient level and use it. Do not",
    "default to subagents; do not avoid them when they genuinely pay for themselves.",
    "0. Conversational or knowledge questions: answer directly, no tools.",
    "1. Small targeted lookups where you can name the files: read them yourself",
    "   (plus the read-only git evidence commands).",
    "2. ONE unknown area needing broad search or wide context gathering: a single",
    "   investigator task.",
    "3. Context needs spanning 2-4 DISJOINT areas: parallel investigator scouts -",
    "   multiple task calls in one assistant turn, each a self-contained,",
    "   non-overlapping question. Scouts are read-only, so scout fan-out is always",
    "   safe; prefer it over sequential scouting when the areas are independent.",
    "4. A single-stage change: one executor delegation.",
    "5. Genuinely independent workstreams: parallel executor tasks - ONLY after",
    "   the parallel-safety verification below passes.",
    "6. Dependent multi-stage work: checkpointed milestones - sequential, one",
    "   delegation per milestone.",
    "Never send the investigator for what one read answers; never delegate",
    "execution for a question; never fan out overlapping scopes. When the choice",
    "is not obvious, say in one line which level you picked and why.",
    "",
    "Independent parallel fan-out (verify before executing in parallel):",
    "- You may emit multiple task tool calls in one assistant turn only when the",
    "  delegated jobs are genuinely independent: no ordering dependency, no shared",
    "  file ownership, and no need for one result to shape another delegation.",
    "- Parallel EXECUTOR fan-out must be verified, not assumed. Before emitting",
    "  parallel executor tasks, confirm and state: disjoint file ownership (name",
    "  the files each child owns), no ordering dependency, and no shared artifacts",
    "  (lockfiles, generated files, migration chains, the same tests). If you",
    "  cannot verify disjointness from what you already know, send investigator",
    "  scouts first or stay sequential - sequential milestones are always correct.",
    "- Give each parallel executor/investigator a self-contained, disjoint scope",
    "  and explicit acceptance criteria. If two tasks could edit or verify the",
    "  same files, do not run them in parallel.",
    "- Do not use parallel fan-out for checkpointed milestones whose correctness",
    "  depends on reviewing the previous milestone. Those remain sequential: wait",
    "  for the return, perform your independent check, then compose the next task.",
    "- When parallel tasks return, review each result independently, check whether",
    "  the children touched the same files (a failed disjointness assumption -",
    "  re-read those files first), and reconcile conflicts or overlaps. After a",
    "  parallel executor batch, run your independent integration check (git",
    "  evidence, read the combined changes, or an investigator pass) before",
    "  declaring completion or delegating follow-up.",
    "",
    "Checkpointed delegation (mandatory for multi-stage work):",
    "- When a task spans multiple coherent stages - a multi-file feature, a refactor",
    "  plus behavior changes, anything where an early wrong choice cascades - do not",
    "  hand the executor the whole job in one delegation. Define 2-5 milestones,",
    "  each the smallest increment you can verify on its own, with its own",
    "  acceptance criteria.",
    "- Delegate ONE milestone per task call. Tell the executor which milestone of",
    "  the plan it is, its exact scope, and that it must not run ahead into later",
    "  milestones.",
    "- Give the executor ONLY the current milestone's scope; do not spell out later",
    "  milestones in the delegation. Withholding forward knowledge - not the 'must",
    "  not run ahead' note alone - is what actually keeps it from overrunning. Each",
    "  delegation's return is the checkpoint: review it before composing the next.",
    "- Between milestones, review the returned evidence with the same independent",
    "  checks the completion rule requires (git diff/status, read the changed files,",
    "  or an investigator pass) BEFORE delegating the next milestone. Fold what the",
    "  review found into the next delegation; a milestone that fails review gets a",
    "  corrective re-delegation, not a march forward.",
    "- Do not micro-slice: a milestone is an independently verifiable increment,",
    "  not an individual edit. A small single-stage task stays one delegation.",
    "",
    "Background delegation (detached executor tasks):",
    "- The background_task tool runs ONE executor delegation DETACHED: it returns",
    "  {status:'started', taskId, title} immediately, the work runs while you and",
    "  the user keep talking, and the executor's full report arrives later as an",
    "  [Open Fusion background report] message that opens a new turn for you.",
    "- Default stays the FOREGROUND task tool (blocking). Go background only when",
    "  the user asked for it, or when the work is long, INDEPENDENT, and the user",
    "  wants to keep the conversation available while it runs. After launching,",
    "  end your turn and tell the user exactly what is running in the background.",
    "- Review the arriving report with the SAME completion rule as any executor",
    "  return: independent check first (git evidence, read the changed files, or",
    "  an investigator pass), then present the outcome. Never run milestones that",
    "  depend on each other as concurrent background tasks - a dependent milestone",
    "  waits for the previous report and your review.",
    "- Cancel a running background task with background_cancel {taskId}. A",
    "  detached task cannot ask mid-turn questions; ambiguity comes back in its",
    "  report instead.",
    "- Use background_status with no taskId to peek at running and recently settled",
    "  tasks, or background_status {taskId} for elapsed time, recent activity, and",
    "  files observed so far. It is a read-only snapshot, never a wait operation.",
    "",
    "Completion rule (mandatory before telling the user delegated work is done):",
    "1. Perform at least ONE independent check of the executor's claims: run git diff or",
    "   git status yourself, read the changed files, or send the investigator to verify",
    "   a specific claim. The executor's report alone is never sufficient evidence.",
    "2. State in your reply which independent check you performed and what it showed.",
    "3. An executor report without verbatim evidence (exact commands, verbatim test",
    "   output, the actual diff) is automatically not done: re-delegate and demand the evidence.",
    "4. When the delegated outcome is visual (UI layout or styling, rendered pages,",
    "   images, charts, terminal UI), the evidence must include a visual check the",
    "   executor actually performed: what it rendered or screenshotted, the image",
    "   path, and what it observed. Code reading or passing tests alone never",
    "   verify a visual outcome - re-delegate and demand the visual check, and say",
    "   so in the delegation up front when you can already tell the outcome is visual.",
    "5. This applies to every delegation, including late in long conversations - an",
    "   executor that has been reliable so far does not earn an exemption.",
    "The executor may recommend that work is complete, but you own the final done/not-done decision."
  ].join("\n");
}

function openFusionPlanPrompt() {
  return [
    "# Open Fusion Plan Mode",
    "",
    "You are the Planner inside vibeTerminal Open Fusion, running in PLAN MODE.",
    "The user wants a reviewed plan before any implementation happens.",
    "",
    "Responsibilities:",
    "- Understand the user's goal, then investigate before proposing anything.",
    "- Right-size the research: skip the investigator when your own reads answer",
    "  the question; investigate directly with read, glob, grep, and the read-only",
    "  git evidence commands (git status, git diff, git log, git show).",
    "- Use the task tool with the investigator subagent for wider read-only",
    "  scouting passes: repo layout, relevant files, existing patterns, constraints.",
    "  When the plan needs context from several DISJOINT areas, emit multiple",
    "  investigator task calls in one assistant turn - parallel scouts, each a",
    "  self-contained, non-overlapping question. Scouts are read-only, so scout",
    "  fan-out is always safe.",
    "- Produce a plan the Planner can execute verbatim after the user accepts it.",
    "",
    "Hard limits in plan mode:",
    "- You must not edit files. Edits are permission-denied.",
    "- You must not delegate implementation: the executor subagent is",
    "  permission-denied in plan mode. Do not attempt the call - it will fail.",
    "  Implementation starts only after the user accepts the plan.",
    "- The read-only background_status tool remains available: omit taskId to",
    "  list running/recent tasks, or pass taskId for elapsed time, recent activity,",
    "  and files-so-far. It only peeks; do not poll it in a blocking loop.",
    "",
    "Workspace capabilities (MCP servers & skills):",
    "- This workspace may define MCP servers in `.mcp.json` and skills in",
    "  `.claude/skills` or `.codex/skills`.",
    "- Inspect availability read-only by reading `.mcp.json` or a skill's",
    "  `SKILL.md`. Plan which specific server/tool or skill the executor should",
    "  use later, but do not invoke it yourself.",
    "",
    "Plan shape (match the checkpointed delegation protocol):",
    "- Split multi-stage work into 2-5 milestones, each the smallest increment",
    "  that can be verified on its own, with explicit acceptance criteria.",
    "- Name the files each milestone touches and the checks (commands, tests,",
    "  evidence) that prove it landed.",
    "- Mark milestones that are genuinely independent (disjoint files, no",
    "  ordering dependency, no shared artifacts) as parallelizable so execution",
    "  can fan them out; anything that depends on reviewing an earlier milestone",
    "  stays sequential.",
    "- A small single-stage task stays a single milestone - do not micro-slice.",
    "",
    "End your final message with the complete plan. After the user accepts it,",
    "implementation resumes in normal mode where the executor is available."
  ].join("\n");
}

function openFusionExecutorPrompt() {
  return [
    "# Open Fusion Executor",
    "",
    "You are the executor subagent inside vibeTerminal Open Fusion.",
    "The Planner delegates concrete work to you and owns the final completion decision.",
    "",
    "Responsibilities:",
    "- Implement code changes.",
    "- Run shell commands, tests, builds, and inspections needed to validate the work.",
    "- Interpret command results and fix issues you find.",
    "- Report changed files, commands run, validation results, remaining risks, and a recommendation.",
    "- Reports must carry verbatim primary artifacts, not summaries: the exact commands",
    "  you ran with their exit status, the verbatim final test-runner summary lines,",
    "  and the diff itself (full if small, otherwise a per-file summary plus the",
    "  riskiest hunks verbatim). The Planner treats a report without verbatim",
    "  evidence as incomplete.",
    "",
    "Executor report block (mandatory, fixed and parseable):",
    "End every report with this exact block, preserving the labels and order:",
    "OPEN_FUSION_EXECUTOR_REPORT",
    "ChangedFiles: <paths changed, or none>",
    "Commands: <commands run with exit status, or not run>",
    "Validation: <verbatim final test/build summary lines, or not run>",
    "SelfReview: <review pass findings and fixes>",
    "Risks: <remaining risks, or none>",
    "Recommendation: COMPLETE | CONTINUE | ASK_HUMAN",
    "END_OPEN_FUSION_EXECUTOR_REPORT",
    "Use exactly one Recommendation token: COMPLETE when the delegated scope is satisfied, CONTINUE when the Planner should send another executor pass, or ASK_HUMAN when blocked on user input.",
    "",
    "Workspace capabilities (MCP servers & skills):",
    "If the Planner names a specific MCP server/tool or skill, actually use it for",
    "the work - do not simulate or merely describe it. Confirm the real call",
    "happened and that its output was used in your report. If the named capability",
    "is unavailable, errors, or cannot be exercised, report that as a missing",
    "requirement or risk and recommend CONTINUE or ASK_HUMAN instead of COMPLETE.",
    "Preflight named capabilities before building work on top of them: confirm the",
    "named server's tools are actually available to you and make the first real",
    "call early. If it is not connected - not installed, not running,",
    "unauthenticated, or its tools are absent - stop the dependent work and name",
    "the exact capability plus the failure reason in your report. Recommend",
    "ASK_HUMAN when fixing it needs the user to connect, install, or authenticate",
    "it; recommend CONTINUE only when the Planner could fix it by re-delegating.",
    "",
    "Visual verification (mandatory when the outcome is visual):",
    "When the delegated work changes something a user sees - UI layout or styling,",
    "rendered pages, generated images, charts, terminal UI - code reading and",
    "passing tests are not sufficient validation. Run or render the artifact (dev",
    "server, headless browser, the app's remote-debugging port, or the project's",
    "own preview/screenshot tooling), capture the actual visual state to an image",
    "file, open that image with your image-viewing tool, and check what you see",
    "against the delegated intent. Put the capture command, the image path, and",
    "what you observed on the Validation line of your report.",
    "If you genuinely cannot render or view the result here - the app will not",
    "launch, nothing produces an image, or you cannot view images - say so plainly",
    "in Risks and recommend CONTINUE or ASK_HUMAN; never describe an image you did",
    "not actually view.",
    "",
    "Milestone scope: when the delegation says it is one milestone of a larger",
    "plan, implement ONLY that milestone. Do not run ahead into later milestones",
    "even when the next step looks obvious - the Planner reviews each milestone",
    "before releasing the next. Put anything you learned that affects later",
    "milestones in your report instead of acting on it.",
    "",
    "Parallel workstreams: you may be one of several executors running IN",
    "PARALLEL on this same checkout. Touch ONLY files inside your delegated",
    "scope; if a correct implementation seems to require editing a file outside",
    "it, report the need instead of editing. A file changing underneath you that",
    "you did not edit may be another workstream's work - do not overwrite or",
    "'fix' it; note the overlap in your report.",
    "",
    "Self-review loop (mandatory before returning control):",
    "1. Re-read your full diff as if reviewing another engineer's work: correctness,",
    "   scope drift beyond the delegated task, missed edge cases, leftover debug or",
    "   dead code, and validation gaps.",
    "2. If the review pass found nothing, the loop is done.",
    "3. Otherwise fix the findings, re-run the relevant validation, and review",
    "   again. At most two fix passes: after the second, do one final review and",
    "   report anything it still finds instead of fixing further.",
    "Include what each review pass found and fixed in your report.",
    "Never fabricate, approximate, or reconstruct command or test output. If you did not actually run a command or test, say so plainly rather than reporting an assumed result.",
    "",
    "Concurrent edits: the user may run other agent panes or tools against this",
    "same folder. If an edit is rejected because the file changed after you read",
    "it, re-read before retrying - and if the new content is not your own work,",
    "another agent may be editing this checkout: include that overlap in your",
    "report instead of overwriting the foreign changes.",
    "",
    "Do not claim final completion directly to the user. Return evidence to the Planner so it can decide done vs another correction pass."
  ].join("\n");
}

function openFusionInvestigatorPrompt() {
  return [
    "# Open Fusion Investigator",
    "",
    "You are the read-only investigator subagent inside vibeTerminal Open Fusion.",
    "You do scouting passes so the Planner can make architecture, design, and delegation decisions.",
    "Your permissions are locked read-only: file edits, shell commands, and further delegation are denied.",
    "",
    "Responsibilities:",
    "- Gather the repo context the Planner asked for with read, glob, and grep.",
    "- Prefer fast file discovery, targeted reads, and concise summaries over broad narration.",
    "- You may be one of several scouts running in parallel on disjoint questions:",
    "  stay strictly within your task's stated scope and answer it completely -",
    "  other scouts cover the rest.",
    "",
    "Return a concise report with:",
    "- Findings: concrete facts and constraints.",
    "- Files: relevant file paths and why they matter.",
    "- Snippets: short quoted code snippets only when they are essential.",
    "- Suggested next step: what the Planner should decide or delegate next."
  ].join("\n");
}

function openFusionResolvedModels(options = {}) {
  return {
    plannerModel: normalizeOpenFusionModel(
      options.plannerModel,
      OPEN_FUSION_MODEL_UNSET
    ),
    executorModel: normalizeOpenFusionModel(
      options.executorModel,
      OPEN_FUSION_MODEL_UNSET
    )
  };
}

function openFusionCommandContents(options = {}) {
  const { plannerModel, executorModel } = openFusionResolvedModels(options);

  return {
    delegate: {
      description: "Delegate work to the Open Fusion executor subagent",
      agent: "executor",
      model: executorModel || undefined,
      subtask: true,
      template: [
        "Execute this Open Fusion task as the executor subagent.",
        "",
        "$ARGUMENTS",
        "",
        "Return concise evidence for the Planner: changed files, commands run, validation results, self-review findings per pass, risks, and whether you recommend another pass.",
        "Evidence must be verbatim, not paraphrased: exact commands with exit status, the verbatim final test-runner summary lines, and the diff (full if small, otherwise per-file summary plus the riskiest hunks verbatim).",
        "If the task names a specific MCP server/tool or skill, actually use it - do not simulate it - and report evidence that the real call happened and its output was used. If it is unavailable, errors, or cannot be exercised, report that and recommend CONTINUE or ASK_HUMAN instead of COMPLETE.",
        "Preflight the named capability: confirm it is actually connected (its tools are available to you) with an early real call before depending on it. If it is not connected, name the capability and failure reason in your report and recommend ASK_HUMAN when the user must connect, install, or authenticate it.",
        "If the task's outcome is visual (UI, rendered pages, images, charts, terminal UI), validate it visually: run or render it, capture a screenshot or image file, actually view that image, and report the image path plus what you observed on the Validation line. If you cannot render or view it, say so plainly and recommend CONTINUE or ASK_HUMAN instead of substituting code reading.",
        "End your response with this fixed parseable block exactly once:",
        "OPEN_FUSION_EXECUTOR_REPORT",
        "ChangedFiles: <paths changed, or none>",
        "Commands: <commands run with exit status, or not run>",
        "Validation: <verbatim final test/build summary lines, or not run>",
        "SelfReview: <review pass findings and fixes>",
        "Risks: <remaining risks, or none>",
        "Recommendation: COMPLETE | CONTINUE | ASK_HUMAN",
        "END_OPEN_FUSION_EXECUTOR_REPORT",
        "Use exactly one Recommendation token: COMPLETE, CONTINUE, or ASK_HUMAN.",
        "If this task is one milestone of a larger plan, stay within its stated scope and report impacts on later milestones instead of implementing them."
      ].join("\n")
    },
    investigate: {
      description: "Run a read-only Open Fusion investigation pass",
      agent: "investigator",
      model: executorModel || undefined,
      subtask: true,
      template: [
        "Investigate this read-only as the Open Fusion investigator subagent.",
        "",
        "$ARGUMENTS",
        "",
        "Return findings, relevant files, essential snippets, and the suggested next step for the Planner."
      ].join("\n")
    },
    review: {
      description: "Ask the Open Fusion Planner to review executor evidence",
      agent: "planner",
      model: plannerModel || undefined,
      template: [
        "Review the executor evidence below as the Open Fusion Planner.",
        "",
        "$ARGUMENTS",
        "",
        "Decide whether the work is complete. If it is not complete, write the next concrete instruction for the executor."
      ].join("\n")
    },
    fusion: {
      description: "Show the Open Fusion roles and native CLI controls",
      agent: "planner",
      model: plannerModel || undefined,
      template: [
        "Briefly explain the active Open Fusion operating model to the user.",
        "",
        "Mention:",
        "- Brain/Planner is the primary, human-facing agent: no edits, shell limited to read-only git evidence commands.",
        "- Executor is the delegated implementation subagent.",
        "- Investigator is the permission-locked read-only scouting subagent.",
        "- Use /delegate <task> for executor work and /investigate <question> for read-only scouting.",
        "- Use /brain-model or /executor-model for pane-scoped model settings.",
        "- Use OpenCode's native /models for live Brain model selection in the TUI."
      ].join("\n")
    }
  };
}

function commandMarkdown(command) {
  const frontmatter = [
    "---",
    `description: ${JSON.stringify(command.description || "")}`,
    command.agent ? `agent: ${JSON.stringify(command.agent)}` : null,
    command.model ? `model: ${JSON.stringify(command.model)}` : null,
    command.subtask === true ? "subtask: true" : null,
    "---",
    ""
  ].filter((line) => line !== null);

  return `${frontmatter.join("\n")}${command.template}\n`;
}

function readOpenFusionModelState(modelStatePath) {
  try {
    const data = JSON.parse(fs.readFileSync(modelStatePath, "utf8"));
    // Invalid saved values fall back to the launch opts (undefined here), not
    // to the hard defaults, so a corrupt models.json cannot beat an explicit
    // launch-time model.
    return {
      plannerModel: isValidOpenFusionModel(data?.plannerModel)
        ? data.plannerModel.trim()
        : undefined,
      executorModel: isValidOpenFusionModel(data?.executorModel)
        ? data.executorModel.trim()
        : undefined
    };
  } catch {
    return {};
  }
}

function openFusionTuiPluginSource() {
  return [
    "// vibeterminal-openfusion-tui - auto-generated by vibeTerminal.",
    "// Pane-scoped OpenCode TUI commands. Safe no-op outside Open Fusion.",
    "const MODEL_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;",
    "const MAX_MODEL_LENGTH = 96;",
    "",
    "function validModel(value) {",
    "  const model = String(value || '').trim();",
    "  if (!model || model.length > MAX_MODEL_LENGTH || !MODEL_PATTERN.test(model)) return false;",
    "  const lower = model.toLowerCase();",
    "  return lower !== 'auto' && lower !== 'default';",
    "}",
    "",
    "function defaultModels() {",
    "  return {",
    "    plannerModel: process.env.VIBE_TERMINAL_OPEN_FUSION_PLANNER_MODEL || '',",
    "    executorModel: process.env.VIBE_TERMINAL_OPEN_FUSION_EXECUTOR_MODEL || ''",
    "  };",
    "}",
    "",
    "async function readState() {",
    "  const file = process.env.VIBE_TERMINAL_OPEN_FUSION_MODEL_STATE;",
    "  const defaults = defaultModels();",
    "  if (!file) return defaults;",
    "  try {",
    "    const fs = await import('node:fs/promises');",
    "    const data = JSON.parse(await fs.readFile(file, 'utf8'));",
    "    return {",
    "      plannerModel: validModel(data?.plannerModel) ? String(data.plannerModel).trim() : defaults.plannerModel,",
    "      executorModel: validModel(data?.executorModel) ? String(data.executorModel).trim() : defaults.executorModel",
    "    };",
    "  } catch (_error) {",
    "    return defaults;",
    "  }",
    "}",
    "",
    "async function writeState(patch) {",
    "  const file = process.env.VIBE_TERMINAL_OPEN_FUSION_MODEL_STATE;",
    "  if (!file) return null;",
    "  const fs = await import('node:fs/promises');",
    "  const path = await import('node:path');",
    "  const current = await readState();",
    "  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };",
    "  await fs.mkdir(path.dirname(file), { recursive: true });",
    "  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\\n`);",
    "  return next;",
    "}",
    "",
    "function toast(api, title, message, variant = 'info') {",
    "  api.ui.toast({ title, message, variant, duration: 6000 });",
    "}",
    "",
    "function roleKey(role) {",
    "  return role === 'planner' ? 'plannerModel' : 'executorModel';",
    "}",
    "",
    "function roleLabel(role) {",
    "  return role === 'planner' ? 'Brain' : 'Executor';",
    "}",
    "",
    "async function loadCatalog(api) {",
    "  const result = await api.client.provider.list();",
    "  const data = result && typeof result === 'object' && 'data' in result ? result.data : result;",
    "  if (!data || !Array.isArray(data.all)) throw new Error('provider catalog unavailable');",
    "  return {",
    "    all: data.all,",
    "    connected: new Set(Array.isArray(data.connected) ? data.connected : [])",
    "  };",
    "}",
    "",
    "async function saveModel(api, role, model, provider) {",
    "  await writeState({ [roleKey(role)]: model });",
    "  api.ui.dialog.clear();",
    "  toast(api, 'Open Fusion', `${roleLabel(role)} model saved for the next pane restart: ${model}`, 'success');",
    "  if (provider && provider.needsAuth) {",
    "    toast(api, 'Open Fusion', `Provider '${provider.id}' is not connected. Run: opencode auth login ${provider.id}`, 'warning');",
    "  }",
    "}",
    "",
    "function promptCustomModel(api, role, current) {",
    "  api.ui.dialog.replace(() => api.ui.DialogPrompt({",
    "    title: `${roleLabel(role)} model`,",
    "    placeholder: 'provider/model',",
    "    value: current || '',",
    "    onConfirm: (value) => {",
    "      const model = String(value || '').trim();",
    "      if (!validModel(model)) {",
    "        toast(api, 'Open Fusion', 'Use an explicit provider/model id.', 'warning');",
    "        return;",
    "      }",
    "      saveModel(api, role, model).catch((error) => {",
    "        toast(api, 'Open Fusion', `Could not save model: ${error?.message || error}`, 'error');",
    "      });",
    "    },",
    "    onCancel: () => api.ui.dialog.clear()",
    "  }));",
    "}",
    "",
    "function pickModel(api, role, provider, connected, current) {",
    "  const models = Object.values(provider.models || {})",
    "    .filter((model) => model && model.id && model.status !== 'deprecated')",
    "    .sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')));",
    "  const options = models.map((model) => ({",
    "    title: model.name || model.id,",
    "    value: `${provider.id}/${model.id}`,",
    "    description: model.id",
    "  }));",
    "  options.push({",
    "    title: 'Custom model id...',",
    "    value: '__custom__',",
    "    description: 'Type any provider/model id'",
    "  });",
    "  api.ui.dialog.replace(() => api.ui.DialogSelect({",
    "    title: `${roleLabel(role)} model - ${provider.name || provider.id}`,",
    "    placeholder: 'Search models',",
    "    options,",
    "    current: current || undefined,",
    "    onSelect: (option) => {",
    "      if (!option) return;",
    "      if (option.value === '__custom__') {",
    "        promptCustomModel(api, role, current);",
    "        return;",
    "      }",
    "      saveModel(api, role, option.value, {",
    "        id: provider.id,",
    "        needsAuth: !connected.has(provider.id)",
    "      }).catch((error) => {",
    "        toast(api, 'Open Fusion', `Could not save model: ${error?.message || error}`, 'error');",
    "      });",
    "    }",
    "  }));",
    "}",
    "",
    "function pickProvider(api, role) {",
    "  Promise.all([readState(), loadCatalog(api)]).then(([state, catalog]) => {",
    "    const current = state[roleKey(role)] || '';",
    "    const providers = catalog.all.slice().sort((a, b) => {",
    "      const rank = Number(!catalog.connected.has(a.id)) - Number(!catalog.connected.has(b.id));",
    "      return rank || String(a.name || a.id).localeCompare(String(b.name || b.id));",
    "    });",
    "    const options = providers.map((provider) => ({",
    "      title: provider.name || provider.id,",
    "      value: provider.id,",
    "      description: catalog.connected.has(provider.id)",
    "        ? 'connected'",
    "        : `needs auth: opencode auth login ${provider.id}`,",
    "      category: catalog.connected.has(provider.id) ? 'Connected' : 'Available'",
    "    }));",
    "    options.push({",
    "      title: 'Custom model id...',",
    "      value: '__custom__',",
    "      description: 'Type any provider/model id',",
    "      category: 'Other'",
    "    });",
    "    api.ui.dialog.replace(() => api.ui.DialogSelect({",
    "      title: `${roleLabel(role)} provider`,",
    "      placeholder: 'Search providers',",
    "      options,",
    "      current: current.split('/')[0] || undefined,",
    "      onSelect: (option) => {",
    "        if (!option) return;",
    "        if (option.value === '__custom__') {",
    "          promptCustomModel(api, role, current);",
    "          return;",
    "        }",
    "        const provider = providers.find((entry) => entry.id === option.value);",
    "        if (provider) pickModel(api, role, provider, catalog.connected, current);",
    "      }",
    "    }));",
    "  }).catch((error) => {",
    "    toast(api, 'Open Fusion', `Could not load the provider catalog (${error?.message || error}); enter a model id instead.`, 'warning');",
    "    readState().then((state) => promptCustomModel(api, role, state[roleKey(role)] || ''));",
    "  });",
    "}",
    "",
    "async function showStatus(api) {",
    "  const state = await readState();",
    "  let connected = null;",
    "  try {",
    "    connected = (await loadCatalog(api)).connected;",
    "  } catch (_error) {",
    "    connected = null;",
    "  }",
    "  const describe = (model) => {",
    "    if (!model) return 'unset';",
    "    const providerID = model.split('/')[0];",
    "    return connected && providerID && !connected.has(providerID) ? `${model} (needs auth)` : model;",
    "  };",
    "  toast(api, 'Open Fusion', `Brain: ${describe(state.plannerModel)} | Executor: ${describe(state.executorModel)}`);",
    "}",
    "",
    "export default {",
    "  id: 'vibeterminal-openfusion-tui',",
    "  tui: async (api) => {",
    "    if (process.env.VIBE_TERMINAL_OPEN_FUSION !== '1') return;",
    "    const commands = [",
    "        {",
    "          namespace: 'palette',",
    "          name: 'openfusion.brain_model',",
    "          title: 'Set Brain model',",
    "          desc: 'Pick the pane-scoped Open Fusion Brain provider/model for the next restart',",
    "          category: 'Open Fusion',",
    "          slashName: 'brain-model',",
    "          slashAliases: ['brain'],",
    "          run: () => pickProvider(api, 'planner')",
    "        },",
    "        {",
    "          namespace: 'palette',",
    "          name: 'openfusion.executor_model',",
    "          title: 'Set Executor model',",
    "          desc: 'Pick the pane-scoped Open Fusion Executor provider/model for the next restart',",
    "          category: 'Open Fusion',",
    "          slashName: 'executor-model',",
    "          slashAliases: ['executor', 'body', 'body-model'],",
    "          run: () => pickProvider(api, 'executor')",
    "        },",
    "        {",
    "          namespace: 'palette',",
    "          name: 'openfusion.brain_model_live',",
    "          title: 'Switch live Brain model',",
    "          desc: 'Open OpenCode model selector for the current Brain turn',",
    "          category: 'Open Fusion',",
    "          slashName: 'brain-model-live',",
    "          slashAliases: ['brain-live'],",
    "          run: () => api.keymap.dispatchCommand('model.list')",
    "        },",
    "        {",
    "          namespace: 'palette',",
    "          name: 'openfusion.status',",
    "          title: 'Show Open Fusion status',",
    "          desc: 'Show pane-scoped Brain and Executor model settings',",
    "          category: 'Open Fusion',",
    "          slashName: 'openfusion',",
    "          slashAliases: ['fusion-status'],",
    "          run: () => showStatus(api).catch(() => {})",
    "        }",
    "      ];",
    "    if (typeof api.keymap?.registerLayer === 'function') {",
    "      api.keymap.registerLayer({ commands, bindings: [] });",
    "      return;",
    "    }",
    "    if (typeof api.command?.register === 'function') {",
    "      // Legacy v1 command API expects { value, description, slash, onSelect }.",
    "      api.command.register(() => commands.map((command) => ({",
    "        title: command.title,",
    "        value: command.name,",
    "        description: command.desc,",
    "        category: command.category,",
    "        slash: { name: command.slashName, aliases: command.slashAliases },",
    "        onSelect: () => command.run()",
    "      })));",
    "      return;",
    "    }",
    "    toast(api, 'Open Fusion', 'This OpenCode TUI build does not expose plugin command registration.', 'warning');",
    "  }",
    "};",
    ""
  ].join("\n");
}

function openFusionTheme() {
  return {
    $schema: "https://opencode.ai/theme.json",
    defs: {
      bg: "#0d1110",
      panel: "#101817",
      panel2: "#17211f",
      text: "#f3f2ea",
      muted: "#9aa9a3",
      cyan: "#25d9ff",
      green: "#62e66f",
      amber: "#f5b944",
      red: "#ff6571"
    },
    theme: {
      primary: { dark: "cyan", light: "#007b9b" },
      secondary: { dark: "green", light: "#267338" },
      accent: { dark: "amber", light: "#946214" },
      error: { dark: "red", light: "#bf2738" },
      warning: { dark: "amber", light: "#946214" },
      success: { dark: "green", light: "#267338" },
      text: { dark: "text", light: "#111814" },
      muted: { dark: "muted", light: "#53615b" },
      background: { dark: "bg", light: "#f8faf6" },
      surface: { dark: "panel", light: "#ffffff" },
      panel: { dark: "panel2", light: "#eef5f1" }
    }
  };
}

function stringMap(value) {
  if (!isPlainObject(value)) return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    } else if (typeof item === "number" || typeof item === "boolean") {
      out[key] = String(item);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function openFusionMcpTimeout(server) {
  return (
    positiveInt(server.timeout) ||
    positiveInt(server.tool_timeout_ms) ||
    positiveInt(server.startup_timeout_ms) ||
    (positiveInt(server.tool_timeout_sec) ? server.tool_timeout_sec * 1000 : undefined) ||
    (positiveInt(server.startup_timeout_sec)
      ? server.startup_timeout_sec * 1000
      : undefined)
  );
}

function openFusionMcpServerConfig(server) {
  if (!isPlainObject(server)) return null;

  const enabled =
    typeof server.enabled === "boolean"
      ? server.enabled
      : typeof server.disabled === "boolean"
        ? !server.disabled
        : undefined;
  const timeout = openFusionMcpTimeout(server);

  if (typeof server.command === "string" && server.command.trim()) {
    const args = Array.isArray(server.args)
      ? server.args.filter((item) => typeof item === "string")
      : [];
    const command = [server.command, ...args];
    const environment = stringMap(server.environment) || stringMap(server.env);
    return {
      type: "local",
      command,
      cwd:
        typeof server.cwd === "string" && server.cwd.trim()
          ? server.cwd
          : undefined,
      environment,
      enabled,
      timeout
    };
  }

  if (typeof server.url === "string" && server.url.trim()) {
    const headers = stringMap(server.headers) || stringMap(server.http_headers);
    const oauth =
      server.oauth === false || isPlainObject(server.oauth) ? server.oauth : undefined;
    return {
      type: "remote",
      url: server.url,
      headers,
      oauth,
      enabled,
      timeout
    };
  }

  return null;
}

function openFusionWorkspaceMcpConfig(cwd) {
  if (!cwd) return undefined;
  const mcpPath = path.join(cwd, ".mcp.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed?.mcpServers)) return undefined;

  const servers = {};
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    const config = openFusionMcpServerConfig(server);
    if (config) servers[name] = config;
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

function openFusionWorkspaceSkillsConfig(cwd) {
  if (!cwd) return undefined;
  const paths = [
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".codex", "skills")
  ].filter((skillPath) => {
    try {
      return fs.statSync(skillPath).isDirectory();
    } catch {
      return false;
    }
  });
  return paths.length > 0 ? { paths } : undefined;
}

function openFusionReadOnlyPermissionBase() {
  return {
    // Deny unknown/dynamic action names first; this hard-blocks MCP tools named <server>_<tool>.
    "*": "deny",
    read: {
      "*": "allow",
      "mcp:*": "deny"
    },
    glob: "allow",
    grep: "allow",
    list: "allow",
    todowrite: "allow",
    question: "allow",
    webfetch: "allow",
    websearch: "allow",
    lsp: "allow"
  };
}

// The app-owned "vibeterminal" MCP server every Open Fusion pane carries: it
// exposes background_task/background_cancel/background_status to the Brain
// (dynamic vibeterminal_* tool names). Mutating requests relay to the pane's
// host; status reads the host-maintained pane snapshot at a fixed env-bound path.
function openFusionBackgroundBridgeMcp(bridge) {
  return {
    type: "local",
    command: [bridge.nodePath, bridge.scriptPath],
    environment: {
      ELECTRON_RUN_AS_NODE: "1",
      VIBE_TERMINAL_CALLBACK_URL: bridge.callbackUrl,
      VIBE_TERMINAL_TELEMETRY_TOKEN: bridge.token,
      VIBE_TERMINAL_SESSION_ID: bridge.sessionId,
      VIBE_TERMINAL_LAUNCH_NONCE: bridge.launchNonce,
      VIBE_TERMINAL_BG_STATUS_FILE: bridge.statusPath
    },
    enabled: true
  };
}

function openFusionConfigContents(options = {}) {
  const { plannerModel, executorModel } = openFusionResolvedModels(options);
  const inlinePrompts = options.inlinePrompts === true;
  const backgroundBridge =
    options.backgroundBridge && typeof options.backgroundBridge === "object"
      ? options.backgroundBridge
      : null;
  const workspaceMcp = openFusionWorkspaceMcpConfig(options.cwd);
  const mcp =
    workspaceMcp || backgroundBridge
      ? {
          ...(workspaceMcp || {}),
          ...(backgroundBridge
            ? { vibeterminal: openFusionBackgroundBridgeMcp(backgroundBridge) }
            : {})
        }
      : undefined;
  const skills = openFusionWorkspaceSkillsConfig(options.cwd);

  return {
    $schema: "https://opencode.ai/config.json",
    default_agent: "planner",
    // Unset models are OMITTED (JSON.stringify drops undefined) rather than
    // defaulted: with the app-owned credential store there is no vendor pair
    // to assume, and a missing model must surface as "pick one", not as
    // opencode silently choosing on the user's behalf.
    model: plannerModel || undefined,
    command: openFusionCommandContents({ plannerModel, executorModel }),
    // OpenCode config exposes MCP/skills globally, not per-agent. Planner/plan
    // prompts and permissions keep capability invocation delegated to executor.
    mcp,
    skills,
    agent: {
      planner: {
        description:
          "Primary Open Fusion planner. Observes, delegates to executor, reviews evidence, and gates completion.",
        mode: "primary",
        model: plannerModel || undefined,
        prompt: inlinePrompts
          ? openFusionPlannerPrompt()
          : "{file:./openfusion-planner.md}",
        permission: {
          ...openFusionReadOnlyPermissionBase(),
          edit: "deny",
          // Read-only git evidence channel for the completion gate. Key ORDER is
          // load-bearing: opencode 1.17.11 evaluates rules with findLast (last
          // matching key wins, insertion order, not specificity), so the "*"
          // catch-all must stay FIRST and the --output deny LAST. The trailing
          // " *" glob matches the bare command and arguments but not e.g.
          // "git difftool"; chained commands ("a && b") are permission-checked
          // per subcommand, so the allowlist cannot be laundered via chaining.
          bash: {
            "*": "deny",
            "git status *": "allow",
            "git diff *": "allow",
            "git log *": "allow",
            "git show *": "allow",
            "git * --output*": "deny"
          },
          task: {
            "*": "deny",
            executor: "allow",
            investigator: "allow"
          },
          skill: "deny",
          // The app-owned background bridge is a planner-only capability: the
          // leading "*" deny blocks its dynamic tool names everywhere else;
          // Plan mode gets only the read-only status exception below.
          ...(backgroundBridge
            ? {
                vibeterminal_background_task: "allow",
                vibeterminal_background_cancel: "allow",
                vibeterminal_background_status: "allow"
              }
            : {})
        }
      },
      plan: {
        description:
          "Open Fusion plan mode. Investigates read-only (directly or via the investigator scout) and produces a milestone plan; implementation delegation is denied until the plan is accepted.",
        mode: "primary",
        model: plannerModel || undefined,
        prompt: inlinePrompts
          ? openFusionPlanPrompt()
          : "{file:./openfusion-plan.md}",
        permission: {
          ...openFusionReadOnlyPermissionBase(),
          edit: "deny",
          // Same read-only git evidence channel as the planner. Key ORDER is
          // load-bearing (findLast / last-match-wins) - keep it byte-identical
          // to the planner's map above.
          bash: {
            "*": "deny",
            "git status *": "allow",
            "git diff *": "allow",
            "git log *": "allow",
            "git show *": "allow",
            "git * --output*": "deny"
          },
          // Scout allowed, implementation denied: plan mode may investigate via
          // the investigator but must not reach the executor. Order matters
          // here too - the specific allow must come after the catch-all deny.
          task: {
            "*": "deny",
            investigator: "allow"
          },
          skill: "deny",
          // Status is read-only and useful while planning. Starting/cancelling
          // detached work remains denied by the leading catch-all.
          ...(backgroundBridge ? { vibeterminal_background_status: "allow" } : {})
        }
      },
      executor: {
        description:
          "Open Fusion executor. Implements code, runs commands, fixes issues, self-reviews, and reports evidence to the planner.",
        mode: "subagent",
        model: executorModel || undefined,
        hidden: false,
        prompt: inlinePrompts
          ? openFusionExecutorPrompt()
          : "{file:./openfusion-executor.md}",
        ...(backgroundBridge
          ? {
              permission: {
                vibeterminal_background_task: "deny",
                vibeterminal_background_cancel: "deny",
                vibeterminal_background_status: "deny"
              }
            }
          : {})
      },
      // Detached background executor: PRIMARY on purpose — it drives a
      // host-created session (a subagent as the driving agent of a fresh
      // session is unverified on 1.17.11; a primary agent is the shipped
      // steer-router precedent). Same prompt/model as the executor.
      ...(backgroundBridge
        ? {
            "executor-bg": {
              description:
                "Open Fusion detached background executor. Runs one background delegation on a host-created session and reports like the executor.",
              mode: "primary",
              model: executorModel || undefined,
              hidden: true,
              prompt: inlinePrompts
                ? openFusionExecutorPrompt()
                : "{file:./openfusion-executor.md}",
              permission: {
                vibeterminal_background_task: "deny",
                vibeterminal_background_cancel: "deny",
                vibeterminal_background_status: "deny"
              }
            }
          }
        : {}),
      investigator: {
        description:
          "Open Fusion read-only investigator. Scouts repo context for the planner; cannot edit, run commands, or delegate.",
        mode: "subagent",
        model: executorModel || undefined,
        hidden: false,
        prompt: inlinePrompts
          ? openFusionInvestigatorPrompt()
          : "{file:./openfusion-investigator.md}",
        // Hard read-only: no edits, no shell, and no task laundering (it must
        // not be able to reach the executor to write on its behalf).
        permission: {
          ...openFusionReadOnlyPermissionBase(),
          edit: "deny",
          bash: "deny",
          task: {
            "*": "deny"
          },
          skill: "deny"
        }
      }
    }
  };
}

function pathEnvKey(env = process.env, platform = process.platform) {
  if (platform !== "win32") {
    return "PATH";
  }

  const matchingKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return matchingKey || "Path";
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function safeRemoveDir(target, baseDir = SHIM_BASE_DIR) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(target);
  if (!isInside(resolvedBase, resolvedTarget)) {
    return false;
  }

  try {
    fs.rmSync(resolvedTarget, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
    return false;
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readMarker(dir) {
  try {
    const marker = JSON.parse(
      fs.readFileSync(path.join(dir, OWNER_MARKER), "utf8")
    );
    return marker?.owner === "vibeTerminal-agent-shims" ? marker : null;
  } catch {
    return null;
  }
}

function writeMarker(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, OWNER_MARKER),
    `${JSON.stringify(
      {
        owner: "vibeTerminal-agent-shims",
        pid: process.pid,
        createdAt: new Date().toISOString(),
        ...marker
      },
      null,
      2
    )}\n`
  );
}

function cleanupStaleShimDirs(options = {}) {
  const baseDir = options.baseDir || SHIM_BASE_DIR;
  const currentRunId = options.currentRunId;

  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const removed = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = path.join(baseDir, entry.name);
    const marker = readMarker(entryPath);
    if (!marker || marker.runId === currentRunId) {
      continue;
    }

    if (!options.removeLive && isProcessAlive(marker.pid)) {
      continue;
    }

    if (safeRemoveDir(entryPath, baseDir)) {
      removed.push(entryPath);
    }
  }

  return removed;
}

// Open Fusion per-pane dirs must OUTLIVE the run (models.json carries the TUI
// picker choices to the next pane restart), so unlike shim dirs they cannot be
// GC'd by runId/pid. Instead, sweep dirs whose files have not been touched for
// a month: every pane launch rewrites its config, so any pane still in the
// workspace refreshes itself long before the cutoff.
const OPEN_FUSION_STALE_DIR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function cleanupStaleOpenFusionDirs(openFusionBaseDir, maxAgeMs = OPEN_FUSION_STALE_DIR_MAX_AGE_MS) {
  const sessionsDir = path.join(openFusionBaseDir, "sessions");
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed = [];
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dir = path.join(sessionsDir, entry.name);
    let newest = 0;
    for (const probe of ["models.json", "tui.json"]) {
      try {
        newest = Math.max(newest, fs.statSync(path.join(dir, probe)).mtimeMs);
      } catch {
        // probe file missing; fall back to the dir mtime below
      }
    }
    if (!newest) {
      try {
        newest = fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
    }
    if (newest >= cutoff) {
      continue;
    }
    if (safeRemoveDir(dir, sessionsDir)) {
      removed.push(dir);
    }
  }

  return removed;
}

// ---- app-owned OpenCode home (Open Fusion data ownership) ----
// Open Fusion owns ALL of its data: conversation threads (opencode.db),
// credentials (auth.json), and config live under vibeTerminal's userData —
// never in the user's personal OpenCode install. opencode 1.17 resolves its
// data tree from XDG_DATA_HOME and its global-config dir from XDG_CONFIG_HOME
// (verified in the shipped binary; there is no OPENCODE_DATA escape hatch), so
// pointing both at this home isolates threads, auth, snapshots, and logs in
// one move — and stops ~/.config/opencode/* from loading into pane servers.
// The home is app-level (shared by every pane), NOT per-pane: /connect in one
// pane must serve them all, and it must survive the stale-pane-dir sweep.
function openFusionOpencodeHomePaths(openFusionBaseDir) {
  const homeDir = path.join(openFusionBaseDir, "opencode-home");
  return {
    homeDir,
    dataDir: path.join(homeDir, "data"),
    configDir: path.join(homeDir, "config")
  };
}

function globalOpencodeDataDir(env = process.env) {
  const xdgData = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdgData, "opencode");
}

// One-time migration: threads created before isolation live in the user's
// global store (opencode 1.17 keeps sessions/messages in opencode.db at the
// data-dir root). Seed the app store with a best-effort copy of the db files
// so existing panes stay resumable. Credentials are deliberately NOT copied —
// the user's personal auth.json is not ours to replicate; providers are
// reconnected inside the app. Personal CLI threads ride along inside the db
// snapshot but never surface: discovery filters by launch-time cutoff and
// resume only confirms ids the app itself saved.
function migrateOpenFusionThreadsFromGlobal(dataDir, env = process.env) {
  const markerPath = path.join(dataDir, "opencode", ".vibe-migrated-from-global.json");
  if (fs.existsSync(markerPath)) {
    return { migrated: false, copied: [] };
  }
  const globalDir = globalOpencodeDataDir(env);
  const targetDir = path.join(dataDir, "opencode");
  fs.mkdirSync(targetDir, { recursive: true });
  const copied = [];
  // Copy -wal/-shm alongside the db: SQLite recovers a WAL snapshot via frame
  // checksums, so a mid-write copy degrades to "some tail turns missing", not
  // a corrupt store.
  for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
    const source = path.join(globalDir, name);
    try {
      if (fs.existsSync(source) && !fs.existsSync(path.join(targetDir, name))) {
        fs.copyFileSync(source, path.join(targetDir, name));
        copied.push(name);
      }
    } catch {
      // Best-effort: an unreadable global store means a fresh app store.
    }
  }
  try {
    fs.writeFileSync(
      markerPath,
      `${JSON.stringify({ migratedAt: new Date().toISOString(), copied, from: globalDir }, null, 2)}\n`
    );
  } catch {
    // Marker write failed — the existsSync guards above keep this idempotent.
  }
  return { migrated: copied.length > 0, copied };
}

// The migration snapshot can carry the user's personal CLI threads. Anything
// created before the marker's migratedAt is not provably app-created, so
// history LISTINGS hide it (resume of app-saved ids stays unaffected — the
// confirm path never uses this cutoff). Returns 0 when nothing rode along:
// no marker yet, or a marker recording an empty copy.
function openFusionThreadListCutoffMs(dataDir) {
  const markerPath = path.join(
    dataDir,
    "opencode",
    ".vibe-migrated-from-global.json"
  );
  let stat;
  try {
    stat = fs.statSync(markerPath);
  } catch {
    return 0;
  }
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (Array.isArray(marker.copied) && marker.copied.length === 0) {
      return 0;
    }
    const migratedAt = Date.parse(marker.migratedAt);
    if (Number.isFinite(migratedAt)) {
      return migratedAt;
    }
  } catch {
    // Unreadable marker: fall through to its mtime — written right after the
    // copy, so it still fences off the migrated snapshot.
  }
  return Math.floor(stat.mtimeMs) || 0;
}

function ensureOpenFusionOpencodeHome(openFusionBaseDir, env = process.env) {
  const paths = openFusionOpencodeHomePaths(openFusionBaseDir);
  // Pre-create $XDG_CONFIG_HOME/opencode: the app's role config arrives
  // per-pane via OPENCODE_CONFIG/OPENCODE_CONFIG_CONTENT, and an app-owned
  // global config dir is what keeps the user's ~/.config/opencode out of the
  // loop. User-added custom providers land in its opencode.json (written by
  // the pane's own server via PATCH /global/config).
  const configDir = path.join(paths.configDir, "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(paths.dataDir, "opencode"), { recursive: true });
  // Pin the global config FILENAME: with no file present, opencode creates
  // opencode.jsonc on its first PATCH /global/config write; with opencode.json
  // present it keeps using that. Seeding an empty {} (same as no config) makes
  // the app-owned file deterministic for the custom-provider removal rewrite.
  const configJson = path.join(configDir, "opencode.json");
  if (!fs.existsSync(configJson) && !fs.existsSync(path.join(configDir, "opencode.jsonc"))) {
    fs.writeFileSync(configJson, "{}\n");
  }
  migrateOpenFusionThreadsFromGlobal(paths.dataDir, env);
  return paths;
}

// Drop a user-added custom provider from the app-owned global OpenCode config.
// Additions go through the running server (PATCH /global/config merges and
// live-applies), but a PATCH cannot DELETE a key — null values do not remove
// entries (verified 1.17.11) — so removal rewrites the file directly; the
// caller then nudges running servers with an empty PATCH, which re-reads the
// file and refreshes their instances.
function removeOpenFusionCustomProvider(openFusionBaseDir, providerId) {
  const id = typeof providerId === "string" ? providerId.trim() : "";
  if (!id) {
    return { removed: false };
  }
  const configDir = path.join(
    openFusionOpencodeHomePaths(openFusionBaseDir).configDir,
    "opencode"
  );
  // Homes created before the opencode.json seeding got an opencode.jsonc from
  // opencode's own first PATCH write (it emits plain JSON there), so the
  // entry may live in either file.
  for (const fileName of ["opencode.json", "opencode.jsonc"]) {
    const configPath = path.join(configDir, fileName);
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      continue;
    }
    if (
      !config ||
      typeof config !== "object" ||
      !config.provider ||
      typeof config.provider !== "object" ||
      !Object.prototype.hasOwnProperty.call(config.provider, id)
    ) {
      continue;
    }
    delete config.provider[id];
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return { removed: true };
  }
  return { removed: false };
}

function quoteCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quotePosixShell(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function windowsPowerShellCommand() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const candidate = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return fs.existsSync(candidate) ? candidate : "powershell.exe";
}

function windowsPowerShellShimSource(provider) {
  return [
    "$ErrorActionPreference = 'Continue'",
    `$Provider = ${quotePowerShell(provider)}`,
    "$ProviderArgs = @($args)",
    "",
    "function Send-VibeEvent {",
    "  param([string]$Type, [hashtable]$Extra)",
    "  if ([string]::IsNullOrEmpty($env:VIBE_TERMINAL_CALLBACK_URL) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_TELEMETRY_TOKEN) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_SESSION_ID) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_LAUNCH_NONCE)) {",
    "    return",
    "  }",
    "",
    "  try {",
    "    $payload = [ordered]@{",
    "      type = $Type",
    "      provider = $Provider",
    "      sessionId = $env:VIBE_TERMINAL_SESSION_ID",
    "      launchNonce = $env:VIBE_TERMINAL_LAUNCH_NONCE",
    "      argv = @($ProviderArgs)",
    "      cwd = (Get-Location).ProviderPath",
    "      pid = $PID",
    "      timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "    }",
    "",
    "    if ($Extra) {",
    "      foreach ($key in $Extra.Keys) {",
    "        $payload[$key] = $Extra[$key]",
    "      }",
    "    }",
    "",
    "    $body = $payload | ConvertTo-Json -Compress -Depth 8",
    "    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "    $request = [System.Net.WebRequest]::Create($env:VIBE_TERMINAL_CALLBACK_URL)",
    "    $request.Method = 'POST'",
    "    $request.Timeout = 1000",
    "    $request.ContentType = 'application/json'",
    "    $request.ContentLength = $bytes.Length",
    "    $request.Headers.Set('x-vibe-telemetry-token', $env:VIBE_TERMINAL_TELEMETRY_TOKEN)",
    "    $stream = $request.GetRequestStream()",
    "    try {",
    "      $stream.Write($bytes, 0, $bytes.Length)",
    "    } finally {",
    "      $stream.Dispose()",
    "    }",
    "    $response = $request.GetResponse()",
    "    if ($response) {",
    "      $response.Dispose()",
    "    }",
    "  } catch {",
    "    return",
    "  }",
    "}",
    "",
    "function Get-CommandCandidates {",
    "  param([string]$Command)",
    "  if ([System.IO.Path]::GetFileName($Command) -ne $Command) {",
    "    return @($Command)",
    "  }",
    "",
    "  $preferred = @('.exe', '.ps1', '.cmd', '.bat', '.com')",
    "  $pathExt = @()",
    "  if (-not [string]::IsNullOrEmpty($env:PATHEXT)) {",
    "    $pathExt = $env:PATHEXT -split ';' | Where-Object { $_ }",
    "  }",
    "",
    "  $extensions = @()",
    "  foreach ($extension in @($preferred + $pathExt)) {",
    "    $normalized = $extension.Trim()",
    "    if (-not $normalized) {",
    "      continue",
    "    }",
    "    if (-not $normalized.StartsWith('.')) {",
    "      $normalized = '.' + $normalized",
    "    }",
    "    $lower = $normalized.ToLowerInvariant()",
    "    if ($extensions -notcontains $lower) {",
    "      $extensions += $lower",
    "    }",
    "  }",
    "",
    "  $names = @()",
    "  foreach ($extension in $extensions) {",
    '    $names += "$Command$extension"',
    "  }",
    "  return $names",
    "}",
    "",
    "function Resolve-RealCommand {",
    "  param([string]$Command)",
    "  $originalPath = $env:VIBE_TERMINAL_ORIGINAL_PATH",
    "  if ([string]::IsNullOrEmpty($originalPath)) {",
    "    return $null",
    "  }",
    "",
    "  $separator = [Regex]::Escape([string][System.IO.Path]::PathSeparator)",
    "  foreach ($dir in ($originalPath -split $separator)) {",
    "    if ([string]::IsNullOrWhiteSpace($dir)) {",
    "      continue",
    "    }",
    "",
    "    foreach ($candidate in (Get-CommandCandidates $Command)) {",
    "      $filePath = Join-Path $dir $candidate",
    "      if (Test-Path -LiteralPath $filePath -PathType Leaf) {",
    "        return (Resolve-Path -LiteralPath $filePath).ProviderPath",
    "      }",
    "    }",
    "  }",
    "",
    "  return $null",
    "}",
    "",
    "function Get-PowerShellCommand {",
    "  $candidate = Join-Path $PSHOME 'powershell.exe'",
    "  if (Test-Path -LiteralPath $candidate -PathType Leaf) {",
    "    return $candidate",
    "  }",
    "  return 'powershell.exe'",
    "}",
    "",
    "$Command = Resolve-RealCommand $Provider",
    "if (-not $Command) {",
    "  $message = 'vibeTerminal: could not find real ' + $Provider + ' executable on the original PATH.'",
    "  Send-VibeEvent 'agent.process.exited' @{ exitCode = 127; error = $message }",
    "  [Console]::Error.WriteLine($message)",
    "  exit 127",
    "}",
    "",
    "# Inject per-turn notification hooks for the threaded agents (see agentTelemetry.cjs).",
    "if ($Provider -eq 'claude' -and -not [string]::IsNullOrEmpty($env:VIBE_TERMINAL_CLAUDE_SETTINGS)) {",
    "  $ProviderArgs = @($ProviderArgs) + @('--settings', $env:VIBE_TERMINAL_CLAUDE_SETTINGS)",
    "}",
    "elseif ($Provider -eq 'codex' -and -not [string]::IsNullOrEmpty($env:VIBE_TERMINAL_NOTIFY_PROGRAM)) {",
    "  $notifyValue = \"notify=['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File','$($env:VIBE_TERMINAL_NOTIFY_PROGRAM)','agent.completed']\"",
    "  $ProviderArgs = @($ProviderArgs) + @('-c', $notifyValue)",
    "  if (-not [string]::IsNullOrEmpty($env:VIBE_TERMINAL_CODEX_HOOK_OVERRIDES)) {",
    "    try {",
    "      foreach ($override in ($env:VIBE_TERMINAL_CODEX_HOOK_OVERRIDES | ConvertFrom-Json)) {",
    "        $ProviderArgs = @($ProviderArgs) + @('-c', [string]$override)",
    "      }",
    "    } catch {}",
    "  }",
    "}",
    "$env:Path = $env:VIBE_TERMINAL_ORIGINAL_PATH",
    "$ExitCode = 0",
    "$global:LASTEXITCODE = $null",
    "try {",
    "  $extension = [System.IO.Path]::GetExtension($Command).ToLowerInvariant()",
    "  if ($extension -eq '.ps1') {",
    "    & (Get-PowerShellCommand) -NoProfile -ExecutionPolicy Bypass -File $Command @ProviderArgs",
    "  } else {",
    "    & $Command @ProviderArgs",
    "  }",
    "",
    "  if ($null -ne $global:LASTEXITCODE) {",
    "    $ExitCode = [int]$global:LASTEXITCODE",
    "  } elseif (-not $?) {",
    "    $ExitCode = 1",
    "  }",
    "} catch {",
    "  $ExitCode = 1",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "}",
    "",
    "Send-VibeEvent 'agent.process.exited' @{ exitCode = $ExitCode }",
    "exit $ExitCode"
  ].join(os.EOL);
}

function writeWrapper(shimDir, provider, runnerPath, nodePath) {
  if (process.platform === "win32") {
    const psWrapperPath = path.join(shimDir, `${provider}.ps1`);
    fs.writeFileSync(psWrapperPath, windowsPowerShellShimSource(provider));

    const wrapperPath = path.join(shimDir, `${provider}.cmd`);
    fs.writeFileSync(
      wrapperPath,
      [
        "@echo off",
        `${quoteCmd(windowsPowerShellCommand())} -NoProfile -ExecutionPolicy Bypass -File ${quoteCmd(psWrapperPath)} %*`,
        "exit /b %ERRORLEVEL%"
      ].join(os.EOL)
    );
    return wrapperPath;
  }

  const wrapperPath = path.join(shimDir, provider);
  fs.writeFileSync(
    wrapperPath,
    [
      "#!/usr/bin/env sh",
      `exec ${JSON.stringify(nodePath)} ${JSON.stringify(runnerPath)} ${JSON.stringify(provider)} "$@"`
    ].join("\n")
  );
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function normalizeSessionId(sessionId) {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    Buffer.byteLength(sessionId, "utf8") > MAX_SESSION_ID_BYTES
  ) {
    return null;
  }

  return sessionId;
}

function sessionDirName(sessionId) {
  const readable =
    sessionId
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "session";
  const hash = crypto
    .createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
  return `${readable}-${hash}`;
}

function shimRunnerSource() {
  return String.raw`const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const provider = process.argv[2];
let args = process.argv.slice(3);
const callbackUrl = process.env.VIBE_TERMINAL_CALLBACK_URL;
const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;
const sessionId = process.env.VIBE_TERMINAL_SESSION_ID;
const launchNonce = process.env.VIBE_TERMINAL_LAUNCH_NONCE;
const originalPath = process.env.VIBE_TERMINAL_ORIGINAL_PATH || "";

function pathKey(env = process.env) {
  if (process.platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "Path";
}

function post(event) {
  if (!callbackUrl || !token || !sessionId || !launchNonce) return Promise.resolve();
  const body = JSON.stringify({
    ...event,
    provider,
    sessionId,
    launchNonce,
    argv: args,
    cwd: process.cwd(),
    pid: process.pid,
    timestamp: Date.now()
  });

  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(callbackUrl);
    } catch {
      resolve();
      return;
    }

    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      timeout: 1000,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-vibe-telemetry-token": token
      }
    }, (response) => {
      response.resume();
      response.on("end", resolve);
    });

    request.on("error", resolve);
    request.on("timeout", () => {
      request.destroy();
      resolve();
    });
    request.end(body);
  });
}

function candidates(command) {
  if (path.basename(command) !== command) return [command];
  if (process.platform !== "win32") return [command];
  const preferredExtensions = [".EXE", ".PS1", ".CMD", ".BAT", ".COM"];
  const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const extensions = Array.from(new Set(preferredExtensions.concat(pathext)));
  return extensions.flatMap((extension) => [
    command + extension.toLowerCase(),
    command + extension.toUpperCase()
  ]);
}

function resolveRealCommand(command) {
  const pathParts = originalPath.split(path.delimiter).filter(Boolean);
  for (const dir of pathParts) {
    for (const candidate of candidates(command)) {
      const filePath = path.join(dir, candidate);
      try {
        if (fs.statSync(filePath).isFile()) {
          return filePath;
        }
      } catch {
        // Keep searching.
      }
    }
  }
  return null;
}

function quoteForCmd(value) {
  return "\"" + String(value).replace(/"/g, "\"\"") + "\"";
}

function powershellCommand() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const candidate = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  try {
    if (fs.statSync(candidate).isFile()) return candidate;
  } catch {
    // Fall back to PATH lookup below.
  }
  return "powershell.exe";
}

(async () => {
  const env = { ...process.env };
  env[pathKey(env)] = originalPath;

  const command = resolveRealCommand(provider);
  if (!command) {
    await post({
      type: "agent.process.exited",
      exitCode: 127,
      error: "Could not find real " + provider + " executable on the original PATH."
    });
    process.stderr.write("vibeTerminal: could not find real " + provider + " executable on the original PATH.\n");
    process.exit(127);
  }

  // Inject per-turn notification hooks for the threaded agents (see agentTelemetry.cjs).
  if (provider === "claude" && process.env.VIBE_TERMINAL_CLAUDE_SETTINGS) {
    args = args.concat(["--settings", process.env.VIBE_TERMINAL_CLAUDE_SETTINGS]);
  } else if (provider === "codex" && process.env.VIBE_TERMINAL_NOTIFY_PROGRAM) {
    args = args.concat([
      "-c",
      "notify=['" + process.env.VIBE_TERMINAL_NOTIFY_PROGRAM + "','agent.completed']"
    ]);
    try {
      const overrides = JSON.parse(
        process.env.VIBE_TERMINAL_CODEX_HOOK_OVERRIDES || "[]"
      );
      for (const override of overrides) {
        if (typeof override === "string" && override) {
          args = args.concat(["-c", override]);
        }
      }
    } catch {
      // Lifecycle telemetry is additive; legacy completion still works.
    }
  }

  const isWindowsCommandScript =
    process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const isWindowsPowerShellScript =
    process.platform === "win32" && /\.ps1$/i.test(command);
  const child = isWindowsPowerShellScript
    ? spawn(powershellCommand(), [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        command,
        ...args
      ], {
        env,
        stdio: "inherit"
      })
    : isWindowsCommandScript
      ? spawn(process.env.ComSpec || "cmd.exe", [
        "/d",
        "/c",
        "\"" + [quoteForCmd(command)].concat(args.map(quoteForCmd)).join(" ") + "\""
      ], {
        env,
        stdio: "inherit",
        windowsVerbatimArguments: true
      })
    : spawn(command, args, {
        env,
        stdio: "inherit"
      });

  child.on("error", async (error) => {
    await post({
      type: "agent.process.exited",
      exitCode: 127,
      error: error.message
    });
    process.stderr.write(error.message + "\n");
    process.exit(127);
  });

  child.on("exit", async (code, signal) => {
    await post({
      type: "agent.process.exited",
      exitCode: code,
      signal
    });
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
})();`;
}

// The optional second notify argument. Whitelisted because the argument slot is
// not always ours: codex appends its own JSON payload after the type, so an
// unknown value must be dropped, never forwarded.
const NOTIFY_KNOWN_DETAILS = ["turn-start", "tool", "approval", "question"];

// Tiny Node script (POSIX) that POSTs a single attention event to the local
// telemetry callback. Invoked by the per-provider hooks as
// `node notify-hook.cjs <agent.completed|agent.waiting|agent.failed> [detail]`.
// It reads the pane id and callback details from the env the shim injected,
// ignores unknown extra args (codex appends a JSON payload) and stdin (claude
// pipes hook JSON), and exits quietly when run outside vibeTerminal.
function notifyHookSource() {
  return String.raw`const http = require("http");

const KNOWN_DETAILS = new Set(${JSON.stringify(NOTIFY_KNOWN_DETAILS)});
const type = process.argv[2];
const detailArg = process.argv[3] || "";
const detail = KNOWN_DETAILS.has(detailArg) ? detailArg : "";
let provider = "";
let providerThreadId = "";
let providerTurnId = "";
if (!detail && detailArg) {
  if (type === "agent.completed") provider = "codex";
  try {
    const providerEvent = JSON.parse(detailArg);
    const threadId = providerEvent && providerEvent["thread-id"];
    const turnId = providerEvent && providerEvent["turn-id"];
    if (
      providerEvent &&
      providerEvent.type === "agent-turn-complete" &&
      typeof threadId === "string" &&
      threadId.length > 0 &&
      typeof turnId === "string" &&
      turnId.length > 0
    ) {
      provider = "codex";
      providerThreadId = threadId;
      providerTurnId = turnId;
    }
  } catch {
    // An unknown second argument is neither a detail nor provider metadata.
  }
}

const callbackUrl = process.env.VIBE_TERMINAL_CALLBACK_URL;
const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;
const sessionId = process.env.VIBE_TERMINAL_SESSION_ID;

const launchNonce = process.env.VIBE_TERMINAL_LAUNCH_NONCE;

if (!type || !callbackUrl || !token || !sessionId || !launchNonce) {
  process.exit(0);
}

const event = { type, sessionId, launchNonce, timestamp: Date.now() };
if (detail) event.detail = detail;
if (provider) event.provider = provider;
if (providerThreadId) event.providerThreadId = providerThreadId;
if (providerTurnId) event.providerTurnId = providerTurnId;
const body = JSON.stringify(event);

let url;
try {
  url = new URL(callbackUrl);
} catch {
  process.exit(0);
}

const request = http.request(
  {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    timeout: 1000,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "x-vibe-telemetry-token": token
    }
  },
  (response) => {
    response.resume();
    response.on("end", () => process.exit(0));
  }
);

request.on("error", () => process.exit(0));
request.on("timeout", () => {
  request.destroy();
  process.exit(0);
});
request.end(body);
`;
}

const CODEX_LIFECYCLE_EVENTS = [
  "UserPromptSubmit",
  "PermissionRequest",
  "PreToolUse",
  "PostToolUse"
];

// App-owned observer used by invocation-local Codex hooks. It consumes the hook
// JSON from stdin and never writes stdout, so it cannot change a prompt, tool,
// or approval decision. Turn-scoped subagent hooks intentionally carry the
// parent session id and therefore still describe activity in the root turn;
// explicit subagent event payloads are rejected defensively. Codex's normal
// hook trust review still applies; vibeTerminal never bypasses it.
function codexLifecycleHookSource() {
  return String.raw`const http = require("http");

const callbackUrl = process.env.VIBE_TERMINAL_CALLBACK_URL;
const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;
const paneId = process.env.VIBE_TERMINAL_SESSION_ID;
const launchNonce = process.env.VIBE_TERMINAL_LAUNCH_NONCE;
let raw = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (raw.length < 1024 * 1024) raw += chunk;
});
process.stdin.on("end", () => {
  if (!callbackUrl || !token || !paneId || !launchNonce) process.exit(0);
  let hook;
  try {
    hook = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  if (!hook || hook.subagent || hook.agent_id || hook.agent_type) process.exit(0);

  let type = "";
  let detail = "";
  switch (hook.hook_event_name) {
    case "UserPromptSubmit":
      type = "agent.running";
      detail = "turn-start";
      break;
    case "PermissionRequest":
      type = "agent.waiting";
      detail = "approval";
      break;
    case "PreToolUse":
    case "PostToolUse":
      type = "agent.running";
      detail = "tool";
      break;
    default:
      process.exit(0);
  }

  const body = JSON.stringify({
    type,
    detail,
    provider: "codex",
    sessionId: paneId,
    launchNonce,
    providerThreadId: typeof hook.session_id === "string" ? hook.session_id : undefined,
    providerTurnId: typeof hook.turn_id === "string" ? hook.turn_id : undefined,
    timestamp: Date.now()
  });
  let url;
  try {
    url = new URL(callbackUrl);
  } catch {
    process.exit(0);
  }
  const request = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    timeout: 1000,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "x-vibe-telemetry-token": token
    }
  }, (response) => {
    response.resume();
    response.on("end", () => process.exit(0));
  });
  request.on("error", () => process.exit(0));
  request.on("timeout", () => {
    request.destroy();
    process.exit(0);
  });
  request.end(body);
});
process.stdin.resume();
`;
}

function codexLifecycleConfigOverrides(nodePath, hookPath, isWin) {
  let handler;
  if (isWin) {
    // PowerShell -> .cmd native argv forwarding strips nested double quotes.
    // An encoded command leaves the complete -c TOML value as one safe arg.
    const script = `$env:ELECTRON_RUN_AS_NODE='1'; & ${quotePowerShell(nodePath)} ${quotePowerShell(hookPath)}`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const command = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
    handler = `[{ hooks = [{ type = 'command', command = '${command}', timeout = 5 }] }]`;
  } else {
    const command = `ELECTRON_RUN_AS_NODE=1 ${quotePosixShell(nodePath)} ${quotePosixShell(hookPath)}`;
    handler = `[{ hooks = [{ type = "command", command = ${JSON.stringify(command)}, timeout = 5 }] }]`;
  }
  return CODEX_LIFECYCLE_EVENTS.map((eventName) =>
    `hooks.${eventName}=${handler}`
  );
}

// Windows notify program body (PowerShell). Same contract as notifyHookSource
// but implemented without Node so it works regardless of whether the user has
// `node` on PATH. `$args[0]` is the attention type, `$args[1]` the optional
// whitelisted detail (codex appends its own JSON payload there, hence the guard).
function windowsNotifyPs1Source() {
  const knownDetails = NOTIFY_KNOWN_DETAILS.map((d) => `'${d}'`).join(", ");
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$Type = $args[0]",
    `$KnownDetails = @(${knownDetails})`,
    "$Detail = ''",
    "$Provider = ''",
    "$ProviderThreadId = ''",
    "$ProviderTurnId = ''",
    "if ($args.Count -ge 2 -and $KnownDetails -contains [string]$args[1]) {",
    "  $Detail = [string]$args[1]",
    "} elseif ($args.Count -ge 2) {",
    "  if ($Type -eq 'agent.completed') { $Provider = 'codex' }",
    "  try {",
    "    $ProviderEvent = ([string]$args[1]) | ConvertFrom-Json",
    "    if ([string]$ProviderEvent.type -eq 'agent-turn-complete' -and -not [string]::IsNullOrEmpty([string]$ProviderEvent.'thread-id') -and -not [string]::IsNullOrEmpty([string]$ProviderEvent.'turn-id')) {",
    "      $Provider = 'codex'",
    "      $ProviderThreadId = [string]$ProviderEvent.'thread-id'",
    "      $ProviderTurnId = [string]$ProviderEvent.'turn-id'",
    "    }",
    "  } catch {",
    "    $ProviderThreadId = ''",
    "    $ProviderTurnId = ''",
    "  }",
    "}",
    "if ([string]::IsNullOrEmpty($Type) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_CALLBACK_URL) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_TELEMETRY_TOKEN) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_SESSION_ID) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_LAUNCH_NONCE)) {",
    "  exit 0",
    "}",
    "try {",
    "  $payload = [ordered]@{",
    "    type = $Type",
    "    sessionId = $env:VIBE_TERMINAL_SESSION_ID",
    "    launchNonce = $env:VIBE_TERMINAL_LAUNCH_NONCE",
    "    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  }",
    "  if ($Detail) {",
    "    $payload['detail'] = $Detail",
    "  }",
    "  if ($Provider) { $payload['provider'] = $Provider }",
    "  if ($ProviderThreadId) { $payload['providerThreadId'] = $ProviderThreadId }",
    "  if ($ProviderTurnId) { $payload['providerTurnId'] = $ProviderTurnId }",
    "  $body = $payload | ConvertTo-Json -Compress",
    "  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "  $request = [System.Net.WebRequest]::Create($env:VIBE_TERMINAL_CALLBACK_URL)",
    "  $request.Method = 'POST'",
    "  $request.Timeout = 1000",
    "  $request.ContentType = 'application/json'",
    "  $request.ContentLength = $bytes.Length",
    "  $request.Headers.Set('x-vibe-telemetry-token', $env:VIBE_TERMINAL_TELEMETRY_TOKEN)",
    "  $stream = $request.GetRequestStream()",
    "  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }",
    "  $response = $request.GetResponse()",
    "  if ($response) { $response.Dispose() }",
    "} catch {",
    "  exit 0",
    "}",
    "exit 0"
  ].join(os.EOL);
}

// POSIX notify program: a shell wrapper that runs the Node hook. Forces
// ELECTRON_RUN_AS_NODE so the bundled Electron binary behaves as Node when it
// is used as the runtime (a no-op for a real `node`).
function posixNotifyShSource(nodePath, notifyHookPath) {
  return [
    "#!/usr/bin/env sh",
    `ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(nodePath)} ${JSON.stringify(
      notifyHookPath
    )} "$@"`
  ].join("\n");
}

// One env-guarded notify program backs every Cursor hook (verified to fire only
// in the interactive CLI). Two shapes:
//   * turn START (beforeSubmitPrompt) passes the type as an argument
//     (`... agent.running`) so we never have to parse the prompt payload;
//   * turn END (stop) passes no argument, and the type is derived from the
//     `status` (completed|aborted|error) the hook pipes on stdin, so a single
//     `stop` reports done, failed, AND user-aborted — an interrupted turn is
//     not "done"; it is the user's turn, i.e. waiting.
// stdin is always drained (even when the type comes from the argument) so Cursor
// never blocks writing a large hook payload to a program that isn't reading it.
// The env guard makes the project hook inert for plain `cursor-agent` runs and
// the Cursor IDE, which carry no VIBE_TERMINAL_* env.
const CURSOR_HOOK_MARKER = "vibeterminal-cursor-notify";
const CURSOR_RUNNING_TYPE = "agent.running";
// The only types the notify program is ever allowed to POST. A bad/unknown
// argument or unparseable stdin therefore stays silent instead of POSTing junk.
const CURSOR_KNOWN_TYPES = [
  "agent.running",
  "agent.completed",
  "agent.waiting",
  "agent.failed"
];

function cursorTypeFromStatus(status) {
  const normalized = String(status || "");
  if (normalized === "error") {
    return "agent.failed";
  }
  if (normalized === "aborted") {
    return "agent.waiting";
  }
  return "agent.completed";
}

// Windows notify program (PowerShell). Type comes from the first argument (turn
// start) or, absent that, from the stdin JSON `status` (turn end); POSTs it.
function windowsCursorNotifyPs1Source() {
  const knownTypeGuard = CURSOR_KNOWN_TYPES.map(
    (type) => `$type -ne '${type}'`
  ).join(" -and ");
  return [
    `# ${CURSOR_HOOK_MARKER}`,
    "$ErrorActionPreference = 'SilentlyContinue'",
    "if ([string]::IsNullOrEmpty($env:VIBE_TERMINAL_CALLBACK_URL) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_TELEMETRY_TOKEN) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_SESSION_ID) -or [string]::IsNullOrEmpty($env:VIBE_TERMINAL_LAUNCH_NONCE)) {",
    "  exit 0",
    "}",
    "$raw = ''",
    "try { $raw = [Console]::In.ReadToEnd() } catch { $raw = '' }",
    "if ($args.Count -ge 1 -and -not [string]::IsNullOrEmpty([string]$args[0])) {",
    "  $type = [string]$args[0]",
    "} else {",
    "  $status = ''",
    "  try { $status = [string]((($raw | ConvertFrom-Json)).status) } catch { $status = '' }",
    "  $type = if ($status -eq 'error') { 'agent.failed' } elseif ($status -eq 'aborted') { 'agent.waiting' } else { 'agent.completed' }",
    "}",
    `if (${knownTypeGuard}) { exit 0 }`,
    "try {",
    "  $payload = [ordered]@{",
    "    type = $type",
    "    sessionId = $env:VIBE_TERMINAL_SESSION_ID",
    "    launchNonce = $env:VIBE_TERMINAL_LAUNCH_NONCE",
    "    provider = 'cursor'",
    "    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  }",
    "  $body = $payload | ConvertTo-Json -Compress",
    "  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "  $request = [System.Net.WebRequest]::Create($env:VIBE_TERMINAL_CALLBACK_URL)",
    "  $request.Method = 'POST'",
    "  $request.Timeout = 1000",
    "  $request.ContentType = 'application/json'",
    "  $request.ContentLength = $bytes.Length",
    "  $request.Headers.Set('x-vibe-telemetry-token', $env:VIBE_TERMINAL_TELEMETRY_TOKEN)",
    "  $stream = $request.GetRequestStream()",
    "  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }",
    "  $response = $request.GetResponse()",
    "  if ($response) { $response.Dispose() }",
    "} catch {",
    "  exit 0",
    "}",
    "exit 0"
  ].join(os.EOL);
}

// POSIX notify program (Node). Same contract as the PowerShell body: the type is
// the first argument (turn start) or derived from the stdin JSON `status` (turn
// end). A safety timer guarantees it proceeds even if stdin never closes, so the
// hook can never hang the agent.
function cursorNotifyHookSource() {
  return String.raw`const http = require("http");

const KNOWN_TYPES = new Set(${JSON.stringify(CURSOR_KNOWN_TYPES)});
const callbackUrl = process.env.VIBE_TERMINAL_CALLBACK_URL;
const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;
const sessionId = process.env.VIBE_TERMINAL_SESSION_ID;
const argType = process.argv[2] || "";
const launchNonce = process.env.VIBE_TERMINAL_LAUNCH_NONCE;

if (!callbackUrl || !token || !sessionId || !launchNonce) {
  process.exit(0);
}

let raw = "";
let settled = false;

function finish() {
  if (settled) return;
  settled = true;

  let type = argType;
  if (!type) {
    let status = "";
    try {
      status = String(JSON.parse(raw).status || "");
    } catch {
      status = "";
    }
    type =
      status === "error"
        ? "agent.failed"
        : status === "aborted"
          ? "agent.waiting"
          : "agent.completed";
  }
  if (!KNOWN_TYPES.has(type)) {
    process.exit(0);
    return;
  }

  const body = JSON.stringify({ type, sessionId, launchNonce, provider: "cursor", timestamp: Date.now() });

  let url;
  try {
    url = new URL(callbackUrl);
  } catch {
    process.exit(0);
    return;
  }

  const request = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      timeout: 1000,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-vibe-telemetry-token": token
      }
    },
    (response) => {
      response.resume();
      response.on("end", () => process.exit(0));
    }
  );

  request.on("error", () => process.exit(0));
  request.on("timeout", () => {
    request.destroy();
    process.exit(0);
  });
  request.end(body);
}

process.stdin.on("data", (chunk) => {
  raw += chunk.toString("utf8");
});
process.stdin.on("error", finish);
process.stdin.on("end", finish);
// Never hang if stdin is not piped/closed for some reason.
setTimeout(finish, 1500);
`;
}

function posixCursorNotifyShSource(nodePath, cursorNotifyHookPath) {
  return [
    "#!/usr/bin/env sh",
    `ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(nodePath)} ${JSON.stringify(
      cursorNotifyHookPath
    )} "$@"`
  ].join("\n");
}

// Reject non-plain-object inputs (arrays, null) so a malformed hooks.json never
// gets spread into a corrupt shape.
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOurCursorEntry(entry) {
  return Boolean(
    entry &&
      typeof entry.command === "string" &&
      entry.command.includes(CURSOR_HOOK_MARKER)
  );
}

// The shell command Cursor runs for one of our hooks: invoke the notify program,
// passing the attention type as an argument for the running hooks and nothing for
// the stop hook (which derives it from stdin). Forward slashes in the Windows
// path dodge backslash escaping inside the JSON command string.
function cursorHookCommand(cursorNotifyProgramPath, isWin, type) {
  const arg = type ? ` ${type}` : "";
  return isWin
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${cursorNotifyProgramPath.replace(
        /\\/g,
        "/"
      )}"${arg}`
    : `'${cursorNotifyProgramPath}'${arg}`;
}

// The set of project hooks vibeTerminal installs: turn-start "running" and
// turn-end completed/failed. Returns `{ event, command }` entries for merging.
function cursorHookEntries(cursorNotifyProgramPath, isWin) {
  return [
    {
      event: "beforeSubmitPrompt",
      command: cursorHookCommand(
        cursorNotifyProgramPath,
        isWin,
        CURSOR_RUNNING_TYPE
      )
    },
    {
      event: "stop",
      command: cursorHookCommand(cursorNotifyProgramPath, isWin)
    }
  ];
}

// Merge our env-guarded hooks into a Cursor `hooks.json` object without disturbing
// the user's own hooks. Idempotent: every prior vibeTerminal entry (identified by
// the marker the notify command carries) is dropped from EVERY event array before
// the current set is appended, so repeated launches never accumulate duplicates,
// a per-run notify path is always refreshed, and dropping an event we no longer
// register leaves no orphan. `entries` is `[{ event, command }]`.
function mergeCursorHooks(existing, entries) {
  const base = isPlainObject(existing) ? { ...existing } : {};
  base.version = base.version || 1;
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};

  for (const key of Object.keys(hooks)) {
    if (Array.isArray(hooks[key])) {
      hooks[key] = hooks[key].filter((entry) => !isOurCursorEntry(entry));
    }
  }

  for (const { event, command } of entries) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...list, { command }];
  }

  // Drop any event array our filtering emptied (e.g. an event we used to
  // register but no longer do) so we never leave a bare `"event": []`.
  for (const key of Object.keys(hooks)) {
    if (Array.isArray(hooks[key]) && hooks[key].length === 0) {
      delete hooks[key];
    }
  }

  base.hooks = hooks;
  return base;
}

// Strip our entries from every event array in a Cursor hooks object (used on
// cleanup). Returns the trimmed object plus whether anything other than our own
// contribution remains, so the caller can delete a file vibeTerminal created.
function stripCursorHooks(existing) {
  const base = isPlainObject(existing) ? { ...existing } : {};
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};

  for (const key of Object.keys(hooks)) {
    if (!Array.isArray(hooks[key])) {
      continue;
    }
    const filtered = hooks[key].filter((entry) => !isOurCursorEntry(entry));
    if (filtered.length > 0) {
      hooks[key] = filtered;
    } else {
      delete hooks[key];
    }
  }
  base.hooks = hooks;

  const hasOtherContent =
    Object.keys(hooks).length > 0 ||
    Object.keys(base).some((key) => key !== "version" && key !== "hooks");
  return { trimmed: base, hasOtherContent };
}

// The architect system prompt a Fusion pane's planner is launched with
// (claude: `--append-system-prompt-file <file>`; codex: thread/start
// developerInstructions). The planner orchestrates read-only; the executor
// engine writes ALL code, owns all execution, and remains the bug +
// goal-completion verifier. Either role can run the Claude or Codex family —
// the bridge tool names keep their codex_ prefix regardless of engine.
function buildFusionSystemPrompt(opts = {}) {
  const plannerLabel =
    opts.plannerFamily === "codex" ? "Codex planner" : "Claude orchestrator";
  const executorLabel =
    opts.executorFamily === "claude"
      ? "a separate Claude executor engine"
      : "Codex";
  return [
    `# Terminal Fusion - you are the ${plannerLabel} (the read-only architect)`,
    "",
    "You are running inside a **Fusion terminal**. You are the human-facing",
    "ORCHESTRATOR, ARCHITECT, DESIGNER, and long-horizon coding controller.",
    `Your counterpart, **${executorLabel}**, is the executor, tester, bug reviewer,`,
    "and goal-completion verifier.",
    "",
    "## Engines and naming",
    "The bridge tools are named codex_* for historical reasons and ALWAYS route",
    "to this pane's configured EXECUTOR engine - which may be a Codex (OpenAI)",
    "or a Claude (Anthropic) engine. Wherever this prompt says \"Codex\", read",
    "\"the executor engine\". Never mention the codex_/engine distinction to the",
    "user; present yourself as one Fusion agent.",
    "Earlier turns in this thread may have been authored by a different engine or model - the user can switch families mid-thread. Judge the code and evidence in front of you, not the apparent authorship, and do not infer your own capabilities from a prior turn's byline.",
    "",
    "## Tooling (read this first)",
    "You have read-only investigation tools (**Read, Grep, Glob**) and the Codex",
    "bridge tools. You have NO file-edit tools: **Edit and Write are blocked.**",
    "ALL code - frontend, backend, config, docs, everything - is written by the",
    "Codex executor via **codex_implement**. Never attempt to modify a file",
    "yourself; specify the change and delegate it.",
    "",
    "## Orchestration triage - right-size every request",
    "Before any work, decide the cheapest sufficient level and use it. Do not",
    "default to subagents; do not avoid them when they genuinely pay for",
    "themselves.",
    "0. Conversational or knowledge questions: answer directly, no tools.",
    "1. Small targeted lookups where you can name the files: your own",
    "   Read/Grep/Glob.",
    "2. ONE unknown area needing broad search, dependency tracing, or",
    "   command-free context gathering: a single codex_investigate scout.",
    "3. Context needs spanning 2-4 DISJOINT areas: parallel scouts -",
    "   codex_investigate with `tasks` (each entry a self-contained,",
    "   non-overlapping question; scouts do not see each other or your",
    "   context). Prefer this over sequential scout calls when the areas are",
    "   independent - the scouts run concurrently.",
    "4. A single-stage change: one codex_implement delegation.",
    "5. Genuinely independent workstreams: codex_implement with `tasks` -",
    "   ONLY after the parallel execution safety check below passes.",
    "6. Dependent multi-stage work: checkpointed milestones (see Checkpointed",
    "   delegation) - sequential, one delegation per milestone.",
    "Never scout what one read answers; never delegate execution for a",
    "question; never fan out overlapping scopes. When the choice is not",
    "obvious, say in one line which level you picked and why.",
    "",
    "## Parallel execution safety check (mandatory before codex_implement tasks)",
    "Executing in parallel is opt-in and must be VERIFIED, not assumed. Before",
    "sending codex_implement with `tasks`, confirm and STATE all of:",
    "- Disjoint file ownership: name the files each workstream owns; no file",
    "  appears in two workstreams.",
    "- No ordering dependency: no workstream needs another's output, types,",
    "  exports, or review to be correct.",
    "- No shared artifacts: not the same lockfiles, generated files, migration",
    "  chains, or test files.",
    "If you cannot verify disjointness from what you already know, scout first",
    "(codex_investigate, or parallel scouts) or stay sequential. When in doubt,",
    "sequential milestones are always correct.",
    "After a parallel fan-out returns: review EVERY workstream's verdict, treat",
    "`fileConflicts` as a failed disjointness assumption (re-read those files",
    "before anything else), and run an integration verification - a final",
    "main-thread codex_implement integration/verify pass or your own",
    "independent review of the combined result - before telling the user the",
    "work is done. A fan-out result never auto-completes the passive Fusion objective.",
    "",
    "## File edit decision policy",
    "You still own HOW a change should be made. When you delegate, tell Codex the",
    "edit shape a careful human engineer would choose: for a local change, name",
    "the file and the smallest coherent block to replace; do not ask for whole-file",
    "rewrites for routine line/function/style tweaks.",
    "Full-file replacement is still valid when creating or regenerating a file,",
    "replacing a generated/tiny artifact, or when a cohesive rewrite is genuinely",
    "safer than many fragile local edits - say so explicitly in the delegation and",
    "tell Codex to preserve unrelated content.",
    "",
    "## Concurrent edits (shared checkout)",
    "The user may run other agent panes or tools against this same folder. If a",
    "file you read earlier has drifted when you or Codex return to it, first ask",
    "whether the change is explained by your own delegation - Codex editing files",
    "you just sent it is normal Fusion operation. If it is NOT (a file neither",
    "you nor Codex touched this turn has drifted), treat the drift as a signal,",
    "not an obstacle: re-read the file, compare the drift against your intent,",
    "and if it looks like another agent's in-progress work, hold that",
    "delegation and surface what you found to the user instead of overwriting it",
    "or silently retrying.",
    "",
    "## Speed and exploration routing",
    "Do not spend expensive Claude turns doing broad repo spelunking. For",
    "exploratory work, file fetching, large searches, dependency tracing, or",
    "multi-file context collection, delegate to **codex_investigate** with a request",
    "to investigate and return concise findings plus the relevant file paths or",
    "snippets. Use those findings to do the architecture/design thinking yourself.",
    "If the user's request depends on a capability you do not have directly,",
    "delegate to Codex instead of guessing, refusing, or describing your limitation.",
    "This includes command output, git state, GitHub/remote release data,",
    "CI/workflow status, network/API access, package/tool versions, OS/environment",
    "state, browser/screenshot/image work, and any future tool or environment",
    "capability outside your direct Read/Grep/Glob surface.",
    "Use **codex_investigate** for read-only checks and context gathering. Use",
    "**codex_implement** when the request requires changing files, creating",
    "tags/releases, pushing, installing packages, or running build/test/debug",
    'commands. Do not answer "I cannot access X here" unless Codex has attempted',
    "the check or action and returned a concrete blocker.",
    "For UI/design/frontend work, you own the design decisions - layout, styling,",
    "component structure, copy - and hand Codex a precise specification (files,",
    "exact intended code shape, even verbatim snippets when that is clearest);",
    "Codex writes the code and runs the verification pass, including screenshots",
    "or browser checks when needed.",
    "When a delegation's acceptance criteria are visual - UI layout or styling,",
    "rendered pages, generated images, charts, terminal UI - say so in the",
    "delegation and require visual evidence: Codex must run or render the result,",
    "capture a screenshot or image file, actually view it, and report what it",
    "observed. A visual delegation that comes back verified only by code reading",
    "or passing tests is NOT verified - redelegate and demand the visual check.",
    "",
    "You do NOT have shell execution. **Bash is blocked.** Do not run commands,",
    "builds, tests, debug scripts, package installs, screenshots, browser control,",
    "or image generation yourself. ALL execution work goes through Codex via",
    "**codex_implement**. Browser navigation/control/automation and picture/image",
    "generation are also Codex-owned execution work in Fusion.",
    "",
    "Use Read/Grep/Glob for pure read-only investigation yourself. Before",
    "delegating backend/core work, broad refactors, or execution-heavy work, do",
    "the cheap read-only triage that identifies files, constraints, existing",
    "patterns, and likely implementation shape. Do not round-trip pure reads,",
    "file discovery, or text search through Codex unless you need an independent",
    "verifier pass or a command/test/browser/image result.",
    "",
    "## Workspace capabilities (MCP servers & skills)",
    "",
    "This workspace may define MCP servers (a project `.mcp.json`, or the user's",
    "`~/.claude` / `~/.codex` config) and skills (`.claude/skills`,",
    "`.codex/skills`). You CANNOT call them: the read-only planner surface does",
    `not expose MCP tools or the Skill tool. ${executorLabel} can.`,
    "Treat them as delegatable capabilities. Inspect what is available read-only",
    "with Read/Grep/Glob (open `.mcp.json`, or a skill's `SKILL.md`, to understand",
    "its inputs and outputs). When a task genuinely benefits from one, name the",
    "SPECIFIC server/tool or skill in your codex_implement delegation and tell the",
    "executor to use it.",
    "The executor discovers workspace capabilities natively and will invoke the",
    "named capability, then verify the result as part of its normal review pass.",
    "Naming the capability makes your intent explicit and lets the verifier confirm",
    "it was actually exercised.",
    "The executor preflights named capabilities and reports one that is not",
    'connected in `missingRequirements` (with `nextAction:"ask_human"` when only',
    "the user can fix it). When a delegation comes back that way, do not",
    "blind-retry the same delegation and do not silently work around it when the",
    "capability matters to the goal: tell the user exactly what to connect - the",
    "server or skill name as configured (`.mcp.json`, `.claude/skills`,",
    "`.codex/skills`) plus the executor's failure reason - and hold the dependent",
    "work until they confirm it is connected. Continue without it only when it is",
    "genuinely optional to the goal, and say you did.",
    "",
    "When the task is frontend/UI/design implementation, use Codex for broad",
    "exploration/debugging/verification, but keep Claude responsible for the UI",
    "design decisions: read the relevant files, decide exactly what should change,",
    "and delegate the writing to Codex with that specification.",
    "When the task needs backend/core changes, broad refactors, generated assets,",
    "runtime debugging, or any command output, delegate that work to Codex instead",
    "of trying to do it yourself.",
    "",
    "## Plan mode",
    "If the user switches Fusion to Plan mode, follow the per-turn Plan directive:",
    "investigate read-only and present a plan. Do not call Codex bridge execution",
    "tools until Auto mode is restored.",
    "",
    "## Your scope",
    "- Architecture and design decisions.",
    "- Long-horizon coding control through Fusion's passive objective record and explicit delegations.",
    "- UI/design/frontend direction: decide what the code should look like and specify it for Codex.",
    "- Planning the work and splitting it into precise, self-contained tasks.",
    "- Guiding Codex with strategy, constraints, UI intent, debugging direction, and follow-up corrections.",
    "- Threat-modeling and debugging *strategy* (what to investigate and why).",
    "- Human-facing tradeoff reasoning and override decisions.",
    "- Reviewing diffs and verifier verdicts with Read/Grep/Glob.",
    '- "What are we missing?" analysis and tradeoff reasoning.',
    "",
    "## Codex's scope",
    "- ALL file modifications: every code change in every layer - frontend, backend, config, docs.",
    "- ALL execution: builds, test runs, app launches, debug commands, package installs, and command output collection.",
    "- Screenshots, browser navigation/control/automation, and picture/image generation.",
    "- Implementation from your specifications, broad refactors, exploratory file gathering, debugging, and verification work you delegate.",
    "- Following Claude's guidance while independently checking the implementation.",
    "- Reviewing for bugs, missed requirements, and whether the user's goal is actually reached.",
    "- Returning evidence against the active objective; the adapter stores that objective passively.",
    "- Returning a structured verifier verdict that gates completion.",
    "",
    "## Fusion objective tracking (passive - never native Goal mode)",
    "For substantial user work, call **codex_goal_set** before the first",
    "codex_implement call. This updates a passive adapter-owned record only:",
    "it never activates Codex native Goal mode, never starts an executor turn,",
    "and never lets Codex continue while idle. Set `objective` to the user's",
    'top-level objective and `status:"active"`, then delegate concrete work.',
    "Use **codex_goal_get** before final completion or when you need the current",
    "objective state. Use **codex_goal_clear** only when the human abandons the",
    "objective or starts a separate unrelated objective.",
    "The adapter creates a passive fallback objective when codex_implement runs",
    "without one and marks it complete only after a successful verifier verdict.",
    "It preserves blocked, usageLimited, and budgetLimited states.",
    "",
    "## One orchestration tree",
    "You are the sole orchestration layer. Do not use any planner engine's native",
    "goal, agent, subagent, or fan-out tools. Launch scouts and executor workers",
    "only through codex_investigate/codex_implement (including their `tasks` fan-out).",
    "Each Codex worker handles one explicit delegation, returns its verdict, and stops.",
    "",
    "## How to delegate to Codex",
    "Use **codex_investigate** for read-only repo scouting, file fetching, large",
    "searches, and findings that should feed Claude's thinking. Ask for concise",
    "findings, relevant file paths, and short snippets. This does not create a",
    "goal and does not run the implementation verifier. When the context you",
    "need spans several disjoint areas, pass `tasks` (2-4 self-contained",
    "questions) to run parallel scouts in one call instead of scouting",
    "sequentially; each scout must be independently answerable because scouts",
    "share nothing.",
    "Use the **codex_implement** tool (NOT your shell, NOT `codex` directly) with",
    "complete, self-contained instructions - Codex does not share your context, so",
    "give it the files, intent, constraints, acceptance criteria, and what to verify.",
    "Delegate in fewer, larger chunks after your read-only triage. A good",
    "handoff bundles the relevant files and findings, the intended behavior,",
    "implementation constraints, likely touch points, acceptance criteria, and",
    "verification expectations into one coherent task. Do not split work into",
    "many small Codex calls for individual reads, single-file edits, or obvious",
    "follow-up checks when one self-contained implementation/review pass can",
    "cover them without losing accuracy. Larger chunks must carry more context,",
    "not vaguer instructions. For multi-stage work, the Checkpointed delegation",
    "section below caps how much goes into a single call.",
    "For UI/design delegations include the visual/UX intent and the exact code",
    "shape you decided on, and ask Codex to review its own diff, run the needed",
    "checks, debug failures, and verify completion.",
    "For picture/image generation include the visual intent, style, dimensions,",
    "asset paths, and acceptance criteria. For browser control include the URL,",
    "viewport or target environment, interaction steps, and what to verify.",
    "Codex runs tests/commands, generates images, controls browsers, fixes bugs,",
    "and verifies goal completion.",
    "Fusion Codex runs with full workspace access and does not prompt for routine",
    "command approvals; you may still see `needs_decision` for genuine questions",
    "or exceptional permission requests.",
    "codex_implement returns one of:",
    "",
    '- `{status:"completed", summary, files, goalReached, bugsFound,',
    '  missingRequirements, nextAction, verifierVerdict, goal}` - inspect the result.',
    '  If `goalReached:false`, `nextAction:"continue"`, bugs are listed, or',
    "  requirements are missing, you MUST continue or redelegate with precise",
    "  instructions. Do not tell the user the task is done.",
    '  If `nextAction:"ask_human"`, ask the human for the missing decision.',
    '  If `goalReached:true` and `nextAction:"done"`, you may finish.',
    '- `{status:"needs_decision", pendingId, kind, detail}` - Codex is asking a',
    "  question or surfaced an exceptional permission request. DECIDE IT YOURSELF and reply",
    "  with **codex_respond** (`decision`: accept | acceptForSession | decline |",
    "  cancel; for a question set decision to accept and put the answer in `note`).",
    "  Only ask the human when you genuinely cannot decide, especially for",
    "  credential risk, external account access, destructive intent, or unclear intent.",
    '- `{status:"steer_routing", userSteer, executorProgress, guidance,',
    '  nextAction:"steer_resolve"}` - the user steered while Codex is still',
    "  executing your codex_implement delegation. The executor is still running.",
    "  Decide immediately with **codex_steer_resolve**: choose `decision:\"push\"`",
    "  with optional refined `text` when the direction should be sent into the",
    "  running executor, or `decision:\"replan\"` when the running executor should",
    "  be interrupted so you can re-delegate a revised plan on the same persistent",
    "  thread. Do not ignore this result or start another codex_implement before",
    "  resolving it.",
    '- `{status:"failed", error}` - diagnose; if Codex is unavailable / not',
    "  authenticated, tell the user to run `codex login` (Codex executor) or",
    "  `claude login` (Claude executor).",
    "",
    "If a Codex turn seems stuck (codex_implement reports a turn already in",
    "progress with no pending decision, or a delegation hangs without progress),",
    "call **codex_cancel** to abort the stuck turn locally, then re-delegate. The",
    "Codex thread survives a cancel.",
    "",
    "## Checkpointed delegation",
    "When the work spans multiple coherent stages - a multi-file feature, a",
    "refactor plus behavior changes, anything where an early wrong choice",
    "cascades - do not send it as one giant delegation. Split it into 2-5",
    "milestones, each an independently verifiable increment with its own",
    "acceptance criteria, and send ONE codex_implement call per milestone.",
    "Tell Codex which milestone of the plan it is, that it must not run ahead",
    "into later milestones, and that `goalReached` refers to the LARGER goal:",
    'mid-plan milestones should come back `goalReached:false`/`nextAction:"continue"` -',
    "that is the expected checkpoint state, not a failure.",
    "Give Codex only the current milestone's scope; do not spell out later milestones",
    "in the delegation. Withholding forward knowledge - not the 'must not run ahead'",
    "note alone - is what actually keeps the executor from overrunning into later",
    "milestones. Each codex_implement return is the checkpoint where you review before",
    "composing the next delegation.",
    "Between milestones, review the returned summary, files, and verdict, and",
    "Read the changed files against your specification BEFORE delegating the",
    "next milestone; fold what the review found into that next delegation. A",
    "milestone that fails your review gets a corrective re-delegation, not a",
    "march forward.",
    "Milestones are not an excuse to micro-slice: within one milestone the",
    "fewer-larger-chunks rule still applies, and a small single-stage task",
    "stays one delegation.",
    "Milestones that are genuinely independent of each other - no checkpoint",
    "dependency, disjoint files - MAY run as one parallel fan-out",
    "(codex_implement `tasks`) after the parallel execution safety check",
    "passes; anything whose correctness depends on reviewing a previous",
    "milestone stays sequential.",
    "",
    "## Background delegation",
    "codex_implement and codex_investigate accept `background: true`: the call",
    "returns {status:'started', taskId, title} immediately, the work runs",
    "detached, and the full report arrives later as a FUSION BACKGROUND TASK",
    "REPORT message that opens a new turn for you. Default stays FOREGROUND",
    "(blocking): background a delegation only when the user asked for it, or",
    "when the work is long, INDEPENDENT, and the user wants to keep talking",
    "with you while it runs. After launching, end your turn and tell the user",
    "exactly what is running in the background.",
    "When the report arrives, review it with the SAME rules as a normal",
    "codex_implement return: run your independent check (Read the changed",
    "files, codex_investigate, or git evidence) before presenting the work,",
    "and let the verifier verdict gate completion. Never run milestones that",
    "depend on each other as concurrent background tasks - a dependent",
    "milestone waits for the previous report and your review. Cancel a",
    "background task with codex_cancel {taskId}. A background task cannot ask",
    "mid-turn questions or approvals; anything ambiguous comes back in its",
    "report instead.",
    "Use codex_task_status with no taskId to peek at running and recently",
    "settled detached tasks, or codex_task_status {taskId} for elapsed time,",
    "recent activity, and files observed so far. It is read-only, works in",
    "Plan mode, and must not be used as a blocking poll loop. When the user",
    "asks how a background task is going, use this status peek; it never",
    "replaces reviewing the final FUSION BACKGROUND TASK REPORT.",
    "",
    "## Completion gate",
    "Codex is the hard verifier for bugs and goal completion. If Codex says the",
    "goal is not reached, continue unless the human explicitly tells you to stop",
    "or you make an explicit higher-level override. If you override Codex, state",
    "`Codex verifier override:` followed by the reason in the transcript.",
    "Review Codex's diffs with Read/Grep/Glob against your specification and",
    "always let Codex's verifier verdict gate completion.",
    "",
    "## User-facing style",
    "Present yourself as one Fusion agent. Do not narrate internal bridge mechanics",
    "such as goal tool calls, pending ids, raw JSON tool results, or tool-name",
    "availability warnings unless the user explicitly asks for implementation",
    "details. Summarize work in human terms: what you are checking, what changed,",
    "what passed, and what still needs a decision.",
    ""
  ].join("\n");
}
// Per-session claude settings file passed via `claude --settings <file>`. Adds
// hooks that fire the notify program on turn completion (Stop) and when claude
// needs the user (Notification). `--settings` merges over the user's own
// settings without mutating ~/.claude.
function buildClaudeSettingsJson(scriptPath, isWin) {
  const hook = (type, detail) => {
    // Keep the command shell-agnostic so it works whatever shell claude runs
    // hooks under: on Windows invoke powershell explicitly against the .ps1
    // (forward slashes dodge backslash-escaping in any shell); on POSIX run the
    // executable notify wrapper directly. The optional detail rides as a second
    // argument (whitelisted by the notify program).
    const args = detail ? `${type} ${detail}` : type;
    const command = isWin
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath.replace(
          /\\/g,
          "/"
        )}" ${args}`
      : `'${scriptPath}' '${type}'${detail ? ` '${detail}'` : ""}`;
    return { type: "command", command, timeout: 5 };
  };

  const settings = {
    hooks: {
      // Turn START: the user submitted a prompt. This is the interaction-proof
      // signal behind the sidebar "working" spinner, so typing or clicking the
      // pane never reads as working. Only THIS running event may override a
      // finished (done/failed) pill: a new turn legitimately supersedes the
      // previous result.
      UserPromptSubmit: [{ matcher: "*", hooks: [hook("agent.running")] }],
      // Tool activity: re-asserts "working" mid-turn (e.g. after a permission
      // approval). Tagged "tool" so the renderer routes it through the
      // done/failed latch — the hooks POST from independent short-lived
      // processes with no ordering guarantee, so a tool hook that lands AFTER
      // the turn's Stop must not resurrect a completed pane's spinner.
      PreToolUse: [{ matcher: "*", hooks: [hook("agent.running", "tool")] }],
      PostToolUse: [{ matcher: "*", hooks: [hook("agent.running", "tool")] }],
      Stop: [{ matcher: "*", hooks: [hook("agent.completed")] }],
      // Split so the pill can tell an approval prompt from an idle "your turn":
      // answering an approval has no hook of its own (PreToolUse fires before
      // the prompt, PostToolUse only when the tool ends), so the renderer flips
      // waiting->running on the user's answer keystroke for approvals only.
      Notification: [
        {
          matcher: "permission_prompt",
          hooks: [hook("agent.waiting", "approval")]
        },
        {
          matcher: "idle_prompt",
          hooks: [hook("agent.waiting", "question")]
        }
      ]
    }
  };

  return `${JSON.stringify(settings, null, 2)}\n`;
}

// Bump on ANY plugin-source change: installOpenCodePlugin only rewrites an
// installed copy when its version string differs.
const OPENCODE_PLUGIN_VERSION = "vibeterminal-notify-5";

// opencode cannot take a per-invocation hook, so we install one small plugin in
// the user's opencode config. It is guarded: it only POSTs when the
// VIBE_TERMINAL_* env vars are present, so a plain `opencode` run does nothing.
//
// Turn START (`agent.running`, the sidebar "working" spinner) is inferred from
// message-stream events: while the assistant is generating, opencode emits a
// burst of `message.*` events, so the FIRST one after idle reports "working" and
// the rest are throttled by the per-turn `busy` latch (reset on every mapped
// event: idle/error end the turn, permission prompts pause it).
//
// Child sessions (task-tool subagents, e.g. the Open Fusion executor) also emit
// `session.idle`/`session.error`, and a child finishing is NOT the pane's turn
// ending — the root session is still driving. Children are recognized by the
// `parentID` their session.created/updated info carries (payload shapes
// verified against opencode 1.17.11: session.idle={sessionID},
// session.created/updated={sessionID,info}, permission.*={...sessionID});
// unknown shapes leave the child set empty, so this fails OPEN to the old
// behavior. Permission asks are never filtered — the user answers them in this
// TUI whichever session raised them.
// NOTE: the exact `message.*` event names are LIVE-VERIFY pending; if they differ
// in a given opencode version the spinner simply won't show (no false positive),
// while done/waiting still flow from session.idle/permission events.
function openCodePluginSource() {
  return [
    `// vibeterminal-notify (${OPENCODE_PLUGIN_VERSION}) - auto-generated by vibeTerminal.`,
    "// Safe no-op outside vibeTerminal: only POSTs when VIBE_TERMINAL_* env vars are set.",
    "export const VibeTerminalNotify = async () => {",
    "  let busy = false;",
    "  const childSessions = new Set();",
    "  const eventSessionId = (event) => {",
    "    const props = event.properties;",
    '    if (!props || typeof props !== "object") return undefined;',
    '    if (typeof props.sessionID === "string") return props.sessionID;',
    '    if (props.info && typeof props.info.sessionID === "string") return props.info.sessionID;',
    "    return undefined;",
    "  };",
    "  return {",
    "    event: async ({ event }) => {",
    "      const url = process.env.VIBE_TERMINAL_CALLBACK_URL;",
    "      const token = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;",
    "      const sessionId = process.env.VIBE_TERMINAL_SESSION_ID;",
    "      const launchNonce = process.env.VIBE_TERMINAL_LAUNCH_NONCE;",
    '      if (!url || !token || !sessionId || !launchNonce || !event || typeof event.type !== "string") {',
    "        return;",
    "      }",
    "      const send = async (type, detail) => {",
    "        try {",
    "          await fetch(url, {",
    '            method: "POST",',
    "            headers: {",
    '              "content-type": "application/json",',
    '              "x-vibe-telemetry-token": token',
    "            },",
    "            // JSON.stringify drops an undefined detail.",
    '            body: JSON.stringify({ type, detail, sessionId, launchNonce, provider: "opencode", timestamp: Date.now() })',
    "          });",
    "        } catch (_error) {",
    "          // Telemetry is best-effort; ignore delivery failures.",
    "        }",
    "      };",
    "      // Track task-tool child sessions from the parentID their info carries.",
    '      if (event.type === "session.created" || event.type === "session.updated") {',
    "        const info = event.properties && event.properties.info;",
    '        if (info && typeof info.id === "string" && info.parentID) {',
    "          childSessions.add(info.id);",
    "        }",
    "        return;",
    "      }",
    '      if (event.type.startsWith("message.")) {',
    "        if (!busy) {",
    "          busy = true;",
    '          await send("agent.running");',
    "        }",
    "        return;",
    "      }",
    "      const map = {",
    '        "session.idle": "agent.completed",',
    '        "permission.asked": "agent.waiting",',
    '        "permission.updated": "agent.waiting",',
    '        "session.error": "agent.failed"',
    "      };",
    "      const type = map[event.type];",
    "      if (!type) {",
    "        return;",
    "      }",
    "      // A child session going idle/erroring is not the pane's turn ending",
    "      // (the root session is still driving) - it must not flash done/failed",
    "      // or drop the busy latch mid-delegation. Permission asks always pass.",
    "      if (",
    '        (event.type === "session.idle" || event.type === "session.error") &&',
    "        childSessions.has(eventSessionId(event))",
    "      ) {",
    "        return;",
    "      }",
    "      // Every mapped event ends the current working stretch: idle/error end",
    "      // the turn, and a permission prompt pauses it with NO event of its own",
    "      // for the approval that resumes it - dropping the latch here lets the",
    "      // next message.* burst re-assert agent.running after the user approves.",
    "      busy = false;",
    '      await send(type, type === "agent.waiting" ? "approval" : undefined);',
    "    }",
    "  };",
    "};",
    ""
  ].join("\n");
}

function installOpenCodePlugin(homeDir = os.homedir()) {
  try {
    const base = path.join(homeDir, ".config", "opencode");
    if (!fs.existsSync(base)) {
      // User has no opencode config yet; install lazily on a later launch.
      return;
    }

    const source = openCodePluginSource();
    // opencode has used both "plugin" and "plugins" for its local-plugin dir
    // across versions; write to both so discovery does not depend on the spelling.
    for (const dirName of ["plugin", "plugins"]) {
      const file = path.join(base, dirName, "vibeterminal-notify.js");
      try {
        if (fs.readFileSync(file, "utf8").includes(OPENCODE_PLUGIN_VERSION)) {
          continue;
        }
      } catch {
        // Not present or unreadable: fall through and (re)write it.
      }
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source);
      } catch {
        // Best-effort; never let plugin install break telemetry startup.
      }
    }
  } catch {
    // Never let opencode plugin install break the telemetry manager.
  }
}

function mapTelemetryToAttention(event) {
  if (event.type === "agent.process.exited") {
    const hasSignal = Boolean(event.signal);
    const exitCode =
      event.exitCode === undefined || event.exitCode === null
        ? null
        : Number(event.exitCode);
    const completed = !hasSignal && exitCode === 0;
    return {
      state: completed ? "completed" : "failed",
      reason: completed ? "done" : "exit",
      source: "shim",
      message: event.error || (hasSignal ? `Exited with signal ${event.signal}.` : undefined),
      updatedAt: Date.now()
    };
  }

  if (event.type === "agent.waiting") {
    // The claude Notification hooks tag the wait: "approval" (permission
    // prompt) vs "question" (idle prompt). The renderer uses the distinction to
    // flip waiting->running on the user's answer keystroke for approvals.
    const reason = event.detail || event.reason;
    return {
      state: "waiting",
      reason: reason === "approval" ? "approval" : "question",
      source: "provider",
      message: event.message,
      updatedAt: Date.now()
    };
  }

  if (event.type === "agent.completed") {
    return {
      state: "completed",
      reason: "done",
      source: "provider",
      message: event.message,
      updatedAt: Date.now()
    };
  }

  if (event.type === "agent.failed") {
    return {
      state: "failed",
      reason: "error",
      source: "provider",
      message: event.message,
      updatedAt: Date.now()
    };
  }

  return null;
}

function createAgentTelemetryManager(options = {}) {
  const baseDir = options.baseDir || SHIM_BASE_DIR;
  const openFusionBaseDir =
    options.openFusionBaseDir || path.join(path.dirname(baseDir), "openfusion");
  const emit = options.emit || (() => {});
  const runId = options.runId || `${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
  const token = options.token || crypto.randomBytes(32).toString("hex");
  const nodePath = options.nodePath || process.execPath;
  const runDir = path.join(baseDir, runId);
  const runnerPath = path.join(runDir, "shim-runner.cjs");
  const isWin = process.platform === "win32";
  const notifyHookPath = path.join(runDir, "notify-hook.cjs");
  const notifyPs1Path = path.join(runDir, "notify.ps1");
  const notifyShPath = path.join(runDir, "notify.sh");
  const codexLifecycleSource = codexLifecycleHookSource();
  // Stable for identical content, but changes when the observer implementation
  // changes. Codex can retain trust for an unchanged definition without a code
  // update silently inheriting that trust. The final rename publishes a complete
  // file atomically when two app instances start together.
  const codexLifecycleVersion = crypto
    .createHash("sha256")
    .update(codexLifecycleSource)
    .digest("hex")
    .slice(0, 12);
  const codexLifecycleHookPath = path.join(
    baseDir,
    `codex-lifecycle-hook-${codexLifecycleVersion}.cjs`
  );
  const codexHookOverrides = codexLifecycleConfigOverrides(
    nodePath,
    codexLifecycleHookPath,
    isWin
  );
  const claudeSettingsPath = path.join(runDir, "claude-settings.json");
  // The single "notify program" each agent invokes with the attention type as
  // its first argument: the PowerShell body on Windows, the sh wrapper on POSIX.
  const notifyProgramPath = isWin ? notifyPs1Path : notifyShPath;
  // Cursor's stop hook derives the attention type from the JSON it pipes on
  // stdin, so it gets its own notify program. The filename carries the marker so
  // mergeCursorHooks can recognise (and refresh) our entry inside the user's
  // project hooks.json across runs.
  const cursorNotifyPs1Path = path.join(runDir, `${CURSOR_HOOK_MARKER}.ps1`);
  const cursorNotifyHookPath = path.join(runDir, `${CURSOR_HOOK_MARKER}.cjs`);
  const cursorNotifyShPath = path.join(runDir, `${CURSOR_HOOK_MARKER}.sh`);
  const cursorNotifyProgramPath = isWin ? cursorNotifyPs1Path : cursorNotifyShPath;
  // Project hooks.json files we have touched this run, mapped to whether the
  // file pre-existed, so cleanup can strip our entry (or delete a file we
  // created) without disturbing the user's own hooks.
  const cursorHookFiles = new Map();
  const sessions = new Map();
  const fusionAdapterControls = new Map();
  const fusionAdapterModes = new Map();
  let server = null;
  let callbackUrl = null;

  const ready = new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      if (!fs.existsSync(codexLifecycleHookPath)) {
        const temporaryLifecyclePath = `${codexLifecycleHookPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
        fs.writeFileSync(temporaryLifecyclePath, codexLifecycleSource);
        try {
          fs.renameSync(temporaryLifecyclePath, codexLifecycleHookPath);
        } catch (error) {
          if (!fs.existsSync(codexLifecycleHookPath)) {
            throw error;
          }
          fs.rmSync(temporaryLifecyclePath, { force: true });
        }
      }
      cleanupStaleShimDirs({ baseDir, currentRunId: runId });
      cleanupStaleOpenFusionDirs(openFusionBaseDir);
      writeMarker(runDir, { runId, type: "run" });
      fs.writeFileSync(runnerPath, shimRunnerSource());

      // Per-turn notification assets: the notify program (PowerShell on Windows,
      // Node-via-sh on POSIX) plus the claude --settings hook file. codex points
      // its `notify` at the same program; opencode uses a guarded global plugin.
      if (isWin) {
        fs.writeFileSync(notifyPs1Path, windowsNotifyPs1Source());
        fs.writeFileSync(cursorNotifyPs1Path, windowsCursorNotifyPs1Source());
      } else {
        fs.writeFileSync(notifyHookPath, notifyHookSource());
        fs.writeFileSync(notifyShPath, posixNotifyShSource(nodePath, notifyHookPath));
        fs.chmodSync(notifyShPath, 0o755);
        fs.writeFileSync(cursorNotifyHookPath, cursorNotifyHookSource());
        fs.writeFileSync(
          cursorNotifyShPath,
          posixCursorNotifyShSource(nodePath, cursorNotifyHookPath)
        );
        fs.chmodSync(cursorNotifyShPath, 0o755);
      }
      fs.writeFileSync(
        claudeSettingsPath,
        buildClaudeSettingsJson(notifyProgramPath, isWin)
      );
      installOpenCodePlugin(options.openCodeHome);

      server = http.createServer((request, response) => {
        if (request.method !== "POST" || request.url !== "/agent-event") {
          response.writeHead(404);
          response.end();
          return;
        }

        if (request.headers["x-vibe-telemetry-token"] !== token) {
          response.writeHead(403);
          response.end();
          return;
        }

        let body = "";
        request.on("data", (chunk) => {
          body += chunk.toString("utf8");
          if (body.length > MAX_EVENT_BYTES) {
            request.destroy();
          }
        });

        request.on("end", () => {
          try {
            const event = JSON.parse(body);
            if (!event.sessionId || typeof event.type !== "string") {
              response.writeHead(400);
              response.end();
              return;
            }

            const normalizedEventSessionId = normalizeSessionId(event.sessionId);
            const activeSession = normalizedEventSessionId
              ? sessions.get(normalizedEventSessionId)
              : null;
            if (
              !activeSession ||
              typeof event.launchNonce !== "string" ||
              event.launchNonce !== activeSession.launchNonce
            ) {
              response.writeHead(409);
              response.end();
              return;
            }

            if (event.type === "fusion.adapterReady") {
              const normalizedSessionId = normalizeSessionId(event.sessionId);
              let controlUrl = null;
              try {
                const parsedUrl = new URL(String(event.controlUrl || ""));
                if (
                  parsedUrl.protocol === "http:" &&
                  parsedUrl.hostname === "127.0.0.1" &&
                  parsedUrl.port
                ) {
                  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");
                  parsedUrl.search = "";
                  parsedUrl.hash = "";
                  controlUrl = parsedUrl.toString().replace(/\/$/, "");
                }
              } catch {
                controlUrl = null;
              }
              if (normalizedSessionId && controlUrl) {
                fusionAdapterControls.set(normalizedSessionId, controlUrl);
              }
              if (normalizedSessionId && controlUrl) {
                void postFusionAdapterControl(normalizedSessionId, "/mode", {
                  mode: fusionAdapterModes.get(normalizedSessionId) || "auto"
                });
              }
            } else if (event.type === "fusion.activity") {
              // Read-only Codex activity for the Fusion pane's role-tagged log
              // (relayed by backend/fusion-adapter.cjs). Not an attention signal.
              emit({
                id: event.sessionId,
                type: "fusion-activity",
                role: event.role,
                kind: event.kind,
                text: event.text,
                ts: event.ts
              });
            } else if (event.type === "fusion.background-task") {
              // Detached background delegation lifecycle from the adapter
              // (started/progress/settled). main routes it into the fusion
              // chat host, which mirrors it to the pane and wakes the planner
              // with the settled report. Not an attention signal.
              emit({
                id: event.sessionId,
                type: "fusion-background-task",
                phase: event.phase,
                taskId: event.taskId,
                title: event.title,
                kind: event.kind,
                task: event.task,
                activityKind: event.activityKind,
                text: event.text,
                updates: event.updates,
                cancelled: event.cancelled,
                durationMs: event.durationMs,
                result: event.result,
                ts: event.ts
              });
            } else if (event.type === "fusion.build-task") {
              // Detached build lifecycle from the adapter. main owns registry
              // mutation/cancellation and mirrors lifecycle events to the pane.
              emit({
                id: event.sessionId,
                type: "fusion-build-task",
                phase: event.phase,
                buildId: event.buildId,
                command: event.command,
                cwd: event.cwd,
                pid: event.pid,
                logPath: event.logPath,
                sentinelPath: event.sentinelPath,
                startedAt: event.startedAt,
                ts: event.ts
              });
            } else if (event.type === "openfusion.background-task") {
              // Brain-initiated background delegation request from the pane's
              // MCP bridge (start/cancel). main routes it to the Open Fusion
              // host, which owns the detached executor session and the wake.
              emit({
                id: event.sessionId,
                type: "openfusion-background-request",
                action: event.action === "cancel" ? "cancel" : "start",
                taskId: event.taskId,
                description: event.description,
                prompt: event.prompt,
                ts: event.ts
              });
            } else if (event.type === "agent.backgroundActivity") {
              const activity = event.backgroundActivity && typeof event.backgroundActivity === "object"
                ? event.backgroundActivity
                : {
                    active: Boolean(event.active),
                    count: Number(event.count) || 0,
                    source: event.source,
                    items: Array.isArray(event.items) ? event.items : [],
                    updatedAt: Number(event.updatedAt) || Date.now()
                  };
              emit({
                id: event.sessionId,
                type: "agent-background-activity",
                provider: event.provider,
                backgroundActivity: activity
              });
            } else if (event.type === "agent.running") {
              // A turn started (provider UserPromptSubmit/busy/before-submit
              // telemetry) or emitted mid-turn tool activity. This drives the pane's
              // "working" state only; it is not an attention/unread signal, so
              // it rides a dedicated event. Only a genuine turn START may
              // override a finished (done/failed) pill; mid-turn tool activity
              // (detail "tool") must respect it, so a tool hook that races past
              // the turn's Stop cannot resurrect the spinner.
              emit({
                id: event.sessionId,
                type: "agent-running",
                provider: event.provider,
                providerThreadId:
                  event.provider === "codex" &&
                  typeof event.providerThreadId === "string"
                    ? event.providerThreadId
                    : undefined,
                providerTurnId:
                  event.provider === "codex" &&
                  typeof event.providerTurnId === "string"
                    ? event.providerTurnId
                    : undefined,
                turnStart: event.detail !== "tool"
              });
            } else {
              const attention = mapTelemetryToAttention(event);
              if (attention) {
                const codexProviderEvent = event.provider === "codex";
                emit({
                  id: event.sessionId,
                  type: "agent-attention",
                  provider: event.provider,
                  providerThreadId:
                    codexProviderEvent && typeof event.providerThreadId === "string"
                      ? event.providerThreadId
                      : undefined,
                  providerTurnId:
                    codexProviderEvent && typeof event.providerTurnId === "string"
                      ? event.providerTurnId
                      : undefined,
                  attention
                });
              }
            }

            response.writeHead(204);
            response.end();
          } catch {
            response.writeHead(400);
            response.end();
          }
        });
      });

      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        callbackUrl = `http://127.0.0.1:${address.port}/agent-event`;
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });

  async function prepareSession(sessionId, options = {}) {
    await ready;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    if (sessions.has(normalizedSessionId)) {
      return sessions.get(normalizedSessionId).instrumentation;
    }

    const sessionDir = path.join(runDir, sessionDirName(normalizedSessionId));
    const shimDir = path.join(sessionDir, "bin");
    fs.mkdirSync(shimDir, { recursive: true });
    writeMarker(sessionDir, {
      runId,
      sessionId: normalizedSessionId,
      type: "session"
    });
    for (const provider of PROVIDERS) {
      writeWrapper(shimDir, provider, runnerPath, nodePath);
    }

    const key = pathEnvKey(process.env);
    const originalPath = process.env[key] || "";
    const nextPath = [shimDir, originalPath].filter(Boolean).join(path.delimiter);
    const launchNonce = crypto.randomBytes(24).toString("base64url");
    const instrumentation = {
      shimDir,
      env: {
        [key]: nextPath,
        VIBE_TERMINAL_SESSION_ID: normalizedSessionId,
        VIBE_TERMINAL_CALLBACK_URL: callbackUrl,
        VIBE_TERMINAL_TELEMETRY_TOKEN: token,
        VIBE_TERMINAL_LAUNCH_NONCE: launchNonce,
        VIBE_TERMINAL_ORIGINAL_PATH: originalPath,
        VIBE_TERMINAL_SHIM_DIR: shimDir,
        VIBE_TERMINAL_CLAUDE_SETTINGS: claudeSettingsPath,
        VIBE_TERMINAL_NOTIFY_PROGRAM: notifyProgramPath,
        VIBE_TERMINAL_CODEX_HOOK_OVERRIDES: JSON.stringify(codexHookOverrides)
      }
    };

    sessions.set(normalizedSessionId, {
      dir: sessionDir,
      launchNonce,
      instrumentation
    });
    return instrumentation;
  }

  async function prepareOpenFusionFiles(sessionId, opts = {}) {
    await ready;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    const instrumentation = await prepareSession(normalizedSessionId);
    if (!instrumentation) {
      return null;
    }

    // App-owned OpenCode home: threads, credentials, and global config for
    // every Open Fusion pane live here, never in the user's personal install.
    const opencodeHome = ensureOpenFusionOpencodeHome(openFusionBaseDir);

    const openFusionDir = path.join(
      openFusionBaseDir,
      "sessions",
      sessionDirName(normalizedSessionId)
    );
    const configDir = path.join(openFusionDir, "config");
    const themesDir = path.join(configDir, "themes");
    const commandsDir = path.join(configDir, "commands");
    // Outside configDir on purpose: the TUI loads this plugin via the tui.json
    // "plugin" entry, while anything under configDir/plugins is also picked up
    // by the server-side loader, which rejects tui-only modules.
    const pluginsDir = path.join(openFusionDir, "plugins");
    fs.mkdirSync(themesDir, { recursive: true });
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.mkdirSync(pluginsDir, { recursive: true });

    const configPath = path.join(configDir, "opencode.json");
    const tuiConfigPath = path.join(openFusionDir, "tui.json");
    const themePath = path.join(themesDir, "vibeterminal-openfusion.json");
    const plannerPromptPath = path.join(configDir, "openfusion-planner.md");
    const planPromptPath = path.join(configDir, "openfusion-plan.md");
    const executorPromptPath = path.join(configDir, "openfusion-executor.md");
    const investigatorPromptPath = path.join(configDir, "openfusion-investigator.md");
    const modelStatePath = path.join(openFusionDir, "models.json");
    const backgroundStatusPath = path.join(openFusionDir, "background-status.json");
    const tuiPluginPath = path.join(pluginsDir, "vibeterminal-openfusion-tui.js");
    const savedModels = readOpenFusionModelState(modelStatePath);
    const effectiveOpts = {
      ...opts,
      plannerModel: savedModels.plannerModel || opts.plannerModel,
      executorModel: savedModels.executorModel || opts.executorModel
    };
    const { plannerModel, executorModel } = openFusionResolvedModels(effectiveOpts);

    fs.writeFileSync(plannerPromptPath, `${openFusionPlannerPrompt()}\n`);
    fs.writeFileSync(planPromptPath, `${openFusionPlanPrompt()}\n`);
    fs.writeFileSync(executorPromptPath, `${openFusionExecutorPrompt()}\n`);
    fs.writeFileSync(investigatorPromptPath, `${openFusionInvestigatorPrompt()}\n`);
    // The pane's app-owned background bridge (Brain-facing background_task
    // MCP tool). The script is spawned by opencode itself, so it gets the
    // callback wiring via the mcp entry's environment.
    const backgroundBridge = {
      nodePath,
      scriptPath: path.join(__dirname, "openFusionBackgroundMcp.cjs"),
      callbackUrl,
      token,
      sessionId: normalizedSessionId,
      launchNonce: instrumentation.env.VIBE_TERMINAL_LAUNCH_NONCE,
      statusPath: backgroundStatusPath
    };
    const fileConfig = openFusionConfigContents({
      plannerModel,
      executorModel,
      cwd: effectiveOpts.cwd,
      backgroundBridge
    });
    const envConfig = openFusionConfigContents({
      plannerModel,
      executorModel,
      cwd: effectiveOpts.cwd,
      inlinePrompts: true,
      backgroundBridge
    });
    fs.writeFileSync(configPath, `${JSON.stringify(fileConfig, null, 2)}\n`);
    for (const [name, command] of Object.entries(openFusionCommandContents({
      plannerModel,
      executorModel
    }))) {
      fs.writeFileSync(path.join(commandsDir, `${name}.md`), commandMarkdown(command));
    }
    fs.writeFileSync(tuiPluginPath, openFusionTuiPluginSource());
    // Drop the pre-picker copy inside configDir: the server-side loader scans
    // that dir and rejects tui-only modules with a load error on every start.
    fs.rmSync(path.join(configDir, "plugins", "vibeterminal-openfusion-tui.js"), {
      force: true
    });
    fs.writeFileSync(
      modelStatePath,
      `${JSON.stringify(
        {
          plannerModel,
          executorModel,
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`
    );
    fs.writeFileSync(themePath, `${JSON.stringify(openFusionTheme(), null, 2)}\n`);
    fs.writeFileSync(
      tuiConfigPath,
      `${JSON.stringify(
        {
          $schema: "https://opencode.ai/tui.json",
          theme: "vibeterminal-openfusion",
          // The TUI plugin host only loads plugins declared in the TUI config;
          // config-dir discovery feeds the server-side loader instead.
          plugin: [url.pathToFileURL(tuiPluginPath).href],
          mouse: true,
          diff_style: "auto",
          attention: {
            enabled: false
          }
        },
        null,
        2
      )}\n`
    );

    return {
      openFusionDir,
      configPath,
      configDir,
      commandsDir,
      pluginsDir,
      tuiConfigPath,
      themePath,
      modelStatePath,
      backgroundStatusPath,
      tuiPluginPath,
      plannerPromptPath,
      planPromptPath,
      executorPromptPath,
      investigatorPromptPath,
      opencodeHome,
      env: {
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(envConfig),
        OPENCODE_TUI_CONFIG: tuiConfigPath,
        OPENCODE_CLIENT: "vibeterminal-openfusion",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        // Full data ownership: opencode's entire data tree (threads in
        // opencode.db, auth.json, snapshots, logs) and its global-config
        // lookup resolve inside the app's own home. Known leak, documented:
        // executor shell commands inherit these XDG overrides (benign on
        // Windows, where nothing standard consumes them).
        XDG_DATA_HOME: opencodeHome.dataDir,
        XDG_CONFIG_HOME: opencodeHome.configDir,
        VIBE_TERMINAL_OPEN_FUSION: "1",
        VIBE_TERMINAL_OPEN_FUSION_DIR: openFusionDir,
        VIBE_TERMINAL_OPEN_FUSION_CONFIG: configPath,
        VIBE_TERMINAL_OPEN_FUSION_TUI_CONFIG: tuiConfigPath,
        VIBE_TERMINAL_OPEN_FUSION_MODEL_STATE: modelStatePath,
        VIBE_TERMINAL_OPEN_FUSION_PLANNER_MODEL: plannerModel,
        VIBE_TERMINAL_OPEN_FUSION_EXECUTOR_MODEL: executorModel
      }
    };
  }

  // Persist pane-scoped Open Fusion Brain/Executor picks (the same models.json
  // the TUI-plugin pickers wrote). prepareOpenFusionFiles re-reads it on the
  // next pane start, so executor changes are restart-applied by construction.
  async function updateOpenFusionModels(sessionId, opts = {}) {
    await ready;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return { status: "failed", error: "missing session id" };
    }
    try {
      const openFusionDir = path.join(
        openFusionBaseDir,
        "sessions",
        sessionDirName(normalizedSessionId)
      );
      const modelStatePath = path.join(openFusionDir, "models.json");
      const current = readOpenFusionModelState(modelStatePath);
      const next = {
        plannerModel:
          typeof opts.plannerModel === "string" && opts.plannerModel.trim()
            ? opts.plannerModel.trim()
            : current.plannerModel || null,
        executorModel:
          typeof opts.executorModel === "string" && opts.executorModel.trim()
            ? opts.executorModel.trim()
            : current.executorModel || null,
        updatedAt: new Date().toISOString()
      };
      fs.mkdirSync(openFusionDir, { recursive: true });
      fs.writeFileSync(modelStatePath, `${JSON.stringify(next, null, 2)}\n`);
      return { status: "ok", modelStatePath, models: next };
    } catch (error) {
      return { status: "failed", error: error?.message || String(error) };
    }
  }

  function fusionRunModePathForSession(normalizedSessionId) {
    return path.join(runDir, sessionDirName(normalizedSessionId), "fusion-run-mode.txt");
  }

  function writeFusionRunModeFile(normalizedSessionId, mode) {
    const runMode = normalizeFusionRunMode(mode);
    const modeFile = fusionRunModePathForSession(normalizedSessionId);
    fs.mkdirSync(path.dirname(modeFile), { recursive: true });
    fs.writeFileSync(modeFile, `${runMode}\n`);
    return modeFile;
  }

  function fusionSettingsPathForSession(normalizedSessionId) {
    return path.join(runDir, sessionDirName(normalizedSessionId), "fusion-settings.json");
  }

  function fusionSettingsFileContents(opts = {}) {
    const executorFamily =
      opts.executorFamily === "claude" || opts.executorFamily === "codex"
        ? opts.executorFamily
        : "codex";
    const executorModel = opts.executorModel || opts.codexModel || null;
    const executorEffort = opts.executorEffort || opts.codexEffort || null;
    const plannerFast = opts.plannerFast === true;
    const executorFast = opts.executorFast === true;
    return {
      plannerFamily: opts.plannerFamily === "codex" ? "codex" : "claude",
      plannerFast,
      // Claude Code consumes this native settings key when the planner family
      // is claude. Codex readers ignore it and use plannerFast/executorFast.
      fastMode: plannerFast,
      executorFamily,
      executorModel,
      executorEffort,
      executorFast,
      // Legacy mirrors: pre-family adapters (and any external reader) keep
      // seeing codexModel/codexEffort when the executor IS codex.
      codexModel: executorFamily === "codex" ? executorModel : null,
      codexEffort: executorFamily === "codex" ? executorEffort : null,
      updatedAt: new Date().toISOString()
    };
  }

  function writeFusionSettingsFile(normalizedSessionId, opts = {}) {
    const settingsFile = fusionSettingsPathForSession(normalizedSessionId);
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const settings = fusionSettingsFileContents(opts);
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    return { settingsFile, settings };
  }

  async function updateFusionSettings(sessionId, opts = {}) {
    await ready;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return { status: "failed", error: "missing session id" };
    }
    try {
      const result = writeFusionSettingsFile(normalizedSessionId, opts);
      return { status: "ok", ...result };
    } catch (error) {
      return { status: "failed", error: error?.message || String(error) };
    }
  }

  // Generate the per-pane Fusion files (Codex MCP adapter config + architect
  // system prompt) for the HEADLESS chat path (backend/fusionChatHost.cjs spawns
  // `claude` with these as explicit argv). Independent of the PTY shim. Returns
  // { systemPromptFile, mcpConfig, settingsFile } absolute paths.
  async function prepareFusionFiles(sessionId, opts = {}) {
    await ready;
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    const instrumentation = await prepareSession(normalizedSessionId);
    if (!instrumentation) {
      return null;
    }

    const sessionDir = path.join(runDir, sessionDirName(normalizedSessionId));
    fs.mkdirSync(sessionDir, { recursive: true });

    const runMode = normalizeFusionRunMode(opts.runMode);
    fusionAdapterModes.set(normalizedSessionId, runMode);
    const runModeFile = writeFusionRunModeFile(normalizedSessionId, runMode);
    const { settingsFile } = writeFusionSettingsFile(normalizedSessionId, opts);

    const plannerFamily =
      opts.plannerFamily === "codex" ? "codex" : "claude";
    const executorFamily =
      opts.executorFamily === "claude" ? "claude" : "codex";
    const systemPromptFile = path.join(sessionDir, "fusion-system-prompt.md");
    fs.writeFileSync(
      systemPromptFile,
      buildFusionSystemPrompt({ plannerFamily, executorFamily })
    );

    const adapterPath = path.join(__dirname, "fusion-adapter.cjs");
    const mcpConfigObj = {
      mcpServers: {
        "fusion-codex": {
          command: nodePath,
          args: [adapterPath],
          // Vendored Codex 0.144 maps this per-server value to the MCP client's
          // tool deadline. Keep planner delegations alive for the 4h ceiling.
          tool_timeout_sec: 14_400,
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            VIBE_FUSION_CODEX_BIN: opts.codexBin || "codex",
            // Pin the user's Codex home so the EMBEDDED binary uses their existing
            // ChatGPT/Codex login (auth.json) with zero re-auth — even if the MCP
            // spawn chain doesn't inherit HOME/USERPROFILE.
            CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
            VIBE_TERMINAL_FUSION_CWD: opts.cwd || "",
            VIBE_TERMINAL_SESSION_ID: normalizedSessionId,
            VIBE_TERMINAL_CALLBACK_URL: callbackUrl,
            VIBE_TERMINAL_TELEMETRY_TOKEN: token,
            VIBE_TERMINAL_LAUNCH_NONCE:
              instrumentation.env.VIBE_TERMINAL_LAUNCH_NONCE,
            VIBE_BUILD_SUPERVISOR_DIR: opts.buildSupervisorDir || "",
            VIBE_FUSION_EAGER_BOOT: "1",
            VIBE_FUSION_RUN_MODE: runMode,
            VIBE_FUSION_RUN_MODE_FILE: runModeFile,
            VIBE_FUSION_CODEX_SETTINGS: settingsFile,
            // The claude-family executor engine spawns a headless `claude`
            // child; dev/test builds can point this at a specific binary.
            VIBE_FUSION_CLAUDE_BIN: process.env.VIBE_CLAUDE_BIN || "claude"
          }
        }
      }
    };
    const mcpConfig = path.join(sessionDir, "fusion-mcp.json");
    fs.writeFileSync(mcpConfig, `${JSON.stringify(mcpConfigObj, null, 2)}\n`);

    return { systemPromptFile, mcpConfig, settingsFile };
  }

  function releaseSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    fusionAdapterControls.delete(normalizedSessionId);
    fusionAdapterModes.delete(normalizedSessionId);
    const session = sessions.get(normalizedSessionId);
    sessions.delete(normalizedSessionId);
    if (session) {
      safeRemoveDir(session.dir, runDir);
    }
  }

  function postFusionAdapterControl(sessionId, pathName, payload = {}) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return Promise.resolve({ status: "skipped", reason: "invalid_session" });
    }
    const controlUrl = fusionAdapterControls.get(normalizedSessionId);
    if (!controlUrl) {
      return Promise.resolve({ status: "skipped", reason: "adapter_not_ready" });
    }
    return new Promise((resolve) => {
      let url;
      try {
        url = new URL(`${controlUrl}${pathName}`);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
          resolve({ status: "skipped", reason: "invalid_adapter_url" });
          return;
        }
      } catch (error) {
        resolve({ status: "skipped", reason: error.message });
        return;
      }

      const body = JSON.stringify({
        sessionId: normalizedSessionId,
        ...payload
      });
      const request = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          timeout: 1000,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "x-vibe-telemetry-token": token
          }
        },
        (response) => {
          let responseBody = "";
          response.on("data", (chunk) => {
            responseBody += chunk.toString("utf8");
          });
          response.on("end", () => {
            try {
              const parsed = JSON.parse(responseBody || "{}");
              resolve(parsed && typeof parsed === "object" ? parsed : { status: "ok" });
            } catch {
              resolve({ status: response.statusCode && response.statusCode >= 400 ? "failed" : "ok" });
            }
          });
        }
      );
      request.on("error", (error) => resolve({ status: "failed", error: error.message }));
      request.on("timeout", () => {
        request.destroy();
        resolve({ status: "failed", error: "adapter control timed out" });
      });
      request.end(body);
    });
  }

  function steerFusionSession(sessionId, text) {
    return postFusionAdapterControl(sessionId, "/steer", { text });
  }

  function setFusionSessionMode(sessionId, mode) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return Promise.resolve({ status: "skipped", reason: "invalid_session" });
    }
    const runMode = normalizeFusionRunMode(mode);
    const previousMode = fusionAdapterModes.get(normalizedSessionId);
    fusionAdapterModes.set(normalizedSessionId, runMode);
    try {
      writeFusionRunModeFile(normalizedSessionId, runMode);
    } catch (error) {
      if (previousMode) {
        fusionAdapterModes.set(normalizedSessionId, previousMode);
      } else {
        fusionAdapterModes.delete(normalizedSessionId);
      }
      return Promise.resolve({ status: "failed", error: error.message || "could not write Fusion mode" });
    }
    return postFusionAdapterControl(normalizedSessionId, "/mode", { mode: runMode }).then(
      (result) => {
        if (result && result.status === "failed" && previousMode) {
          // The mode file is what the adapter re-reads per tool call, so a
          // failed control POST must not leave it ahead of what the renderer
          // committed (it keeps the old mode on ok:false).
          try {
            fusionAdapterModes.set(normalizedSessionId, previousMode);
            writeFusionRunModeFile(normalizedSessionId, previousMode);
          } catch {
            // keep the failed result; the next successful set-mode rewrites it
          }
        }
        return result;
      }
    );
  }

  function interruptFusionSession(sessionId) {
    return postFusionAdapterControl(sessionId, "/interrupt");
  }

  function cancelFusionBackgroundTask(sessionId, taskId) {
    return postFusionAdapterControl(sessionId, "/background-cancel", { taskId });
  }

  function stopFusionSession(sessionId) {
    return postFusionAdapterControl(sessionId, "/stop");
  }

  // Cursor has no per-invocation hook flag, so its hooks are registered in the
  // project's `.cursor/hooks.json`: `beforeSubmitPrompt` -> running and `stop` ->
  // completed/failed. This runs at launch (the cwd is known then) to merge our
  // env-guarded entries in, refreshing the per-run notify path. Best-effort and
  // idempotent; never throws so it cannot break a terminal launch. The user's own
  // Cursor hooks are preserved.
  async function ensureCursorProjectHooks(cwd) {
    try {
      await ready;
      if (!cwd || typeof cwd !== "string") {
        return;
      }

      let stat = null;
      try {
        stat = fs.statSync(cwd);
      } catch {
        return;
      }
      if (!stat.isDirectory()) {
        return;
      }

      const dir = path.join(cwd, ".cursor");
      const file = path.join(dir, "hooks.json");

      let raw = null;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        raw = null;
      }

      let existing = null;
      if (raw !== null) {
        try {
          existing = JSON.parse(raw);
        } catch {
          // The file exists but is not valid JSON. Do not clobber it — the user
          // may be mid-edit or using a format we do not understand.
          return;
        }
      }

      const merged = mergeCursorHooks(
        existing,
        cursorHookEntries(cursorNotifyProgramPath, isWin)
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
      if (!cursorHookFiles.has(file)) {
        cursorHookFiles.set(file, { createdByUs: raw === null });
      }
    } catch {
      // Best-effort; never let cursor hook install break a terminal launch.
    }
  }

  function cleanupCursorHooks() {
    for (const [file, info] of cursorHookFiles) {
      try {
        const raw = fs.readFileSync(file, "utf8");
        const parsed = JSON.parse(raw);
        const { trimmed, hasOtherContent } = stripCursorHooks(parsed);
        if (info.createdByUs && !hasOtherContent) {
          // We created this file purely for our hook; remove it (and the
          // .cursor dir if it is now empty) rather than leave a dangling entry.
          fs.rmSync(file, { force: true });
          const dir = path.dirname(file);
          try {
            if (fs.readdirSync(dir).length === 0) {
              fs.rmdirSync(dir);
            }
          } catch {
            // Directory not empty or unreadable — leave it.
          }
        } else {
          fs.writeFileSync(file, `${JSON.stringify(trimmed, null, 2)}\n`);
        }
      } catch {
        // File gone, unreadable, or malformed — nothing safe to do.
      }
    }
    cursorHookFiles.clear();
  }

  function cleanup() {
    for (const sessionId of Array.from(sessions.keys())) {
      releaseSession(sessionId);
    }
    cleanupCursorHooks();
    if (server) {
      server.close();
      server = null;
    }
    safeRemoveDir(runDir, baseDir);
  }

  return {
    baseDir,
    openFusionBaseDir,
    callbackUrl: () => callbackUrl,
    cleanup,
    ensureCursorProjectHooks,
    // Sync on purpose: thread-discovery lookups need the app-owned OpenCode
    // home paths without awaiting the telemetry bootstrap.
    getOpenFusionOpencodeHome: () => ensureOpenFusionOpencodeHome(openFusionBaseDir),
    getOpenFusionThreadCutoffMs: () =>
      openFusionThreadListCutoffMs(
        openFusionOpencodeHomePaths(openFusionBaseDir).dataDir
      ),
    removeOpenFusionCustomProvider: (providerId) =>
      removeOpenFusionCustomProvider(openFusionBaseDir, providerId),
    prepareSession,
    prepareOpenFusionFiles,
    prepareFusionFiles,
    updateFusionSettings,
    updateOpenFusionModels,
    ready,
    releaseSession,
    steerFusionSession,
    interruptFusionSession,
    cancelFusionBackgroundTask,
    setFusionSessionMode,
    stopFusionSession,
    runDir,
    runId,
    token
  };
}

module.exports = {
  buildClaudeSettingsJson,
  buildFusionSystemPrompt,
  codexLifecycleConfigOverrides,
  codexLifecycleHookSource,
  ensureOpenFusionOpencodeHome,
  migrateOpenFusionThreadsFromGlobal,
  openFusionCommandContents,
  openFusionConfigContents,
  openFusionExecutorPrompt,
  openFusionInvestigatorPrompt,
  openFusionOpencodeHomePaths,
  openFusionPlanPrompt,
  openFusionPlannerPrompt,
  openFusionThreadListCutoffMs,
  openFusionTuiPluginSource,
  removeOpenFusionCustomProvider,
  openFusionTheme,
  cleanupStaleOpenFusionDirs,
  cleanupStaleShimDirs,
  createAgentTelemetryManager,
  cursorHookEntries,
  cursorNotifyHookSource,
  cursorTypeFromStatus,
  installOpenCodePlugin,
  mapTelemetryToAttention,
  mergeCursorHooks,
  notifyHookSource,
  openCodePluginSource,
  safeRemoveDir,
  stripCursorHooks
};
