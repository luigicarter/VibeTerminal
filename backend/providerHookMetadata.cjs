// Shared, passive metadata extraction. These are optional native fields, not
// proof of root ownership. Never forward hook prompts, input, or response bodies.
function hookMetadata(input) {
  const hook = input && typeof input === "object" ? input : {};
  const output = {};
  const fields = {
    providerThreadId: ["session_id", "sessionId", "conversation_id"],
    providerTurnId: ["turn_id", "turnId", "generation_id"],
    toolId: ["tool_use_id", "toolUseId", "tool_call_id", "call_id"],
    toolName: ["tool_name", "toolName"],
    taskId: ["agent_id", "subagent_id", "task_id"],
    taskLabel: ["agent_type", "subagent_type", "task_name"],
    parentThreadId: ["parent_session_id", "parentSessionId", "parent_conversation_id"],
    transcriptPath: ["transcript_path", "transcriptPath"],
    cwd: ["cwd"]
  };
  for (const [key, candidates] of Object.entries(fields)) {
    const value = candidates.map(name => hook[name]).find(value => typeof value === "string" && value.length > 0 && value.length <= 4096);
    if (value) output[key] = value;
  }
  if (!output.taskLabel && ["Task", "Agent"].includes(output.toolName) &&
      typeof hook.tool_input?.description === "string") {
    output.taskLabel = hook.tool_input.description.slice(0, 256);
  }
  const name = hook.hook_event_name || hook.hookEventName || hook.event;
  if (["PreToolUse", "BeforeTool"].includes(name)) output.phase = "start";
  if (["PostToolUse", "PostToolUseFailure", "AfterTool"].includes(name)) output.phase = "stop";
  if (hook.isSidechain === true || hook.is_sidechain === true || hook.subagent === true || output.parentThreadId) output.rootVerified = false;
  return output;
}

// Embedded in generated Node hooks. A missing EOF never delays a provider more
// than 500ms; oversized/truncated JSON yields no identity, not a guessed identity.
function readHookInput(callback) {
  let raw = "";
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    process.stdin.pause();
    callback(raw);
  };
  const timer = setTimeout(finish, 500);
  if (process.stdin.isTTY) { finish(); return; }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    if (raw.length + chunk.length > 1024 * 1024) { raw = ""; finish(); return; }
    raw += chunk;
  });
  process.stdin.on("end", finish);
  process.stdin.on("error", finish);
  process.stdin.resume();
}

function powershellReadHookInput() {
  return [
    "$raw = ''",
    "if ([Console]::IsInputRedirected) {",
    "  try {",
    "    $watch = [Diagnostics.Stopwatch]::StartNew()",
    "    $buffer = New-Object char[] 8192",
    "    $builder = New-Object Text.StringBuilder",
    "    while ($builder.Length -lt 1048576 -and $watch.ElapsedMilliseconds -lt 500) {",
    "      $read = [Console]::In.ReadAsync($buffer, 0, $buffer.Length)",
    "      if (-not $read.Wait([Math]::Max(1, 500 - [int]$watch.ElapsedMilliseconds))) { break }",
    "      if ($read.Result -le 0) { break }",
    "      [void]$builder.Append($buffer, 0, $read.Result)",
    "    }",
    "    if ($builder.Length -lt 1048576) { $raw = $builder.ToString() }",
    "  } catch { $raw = '' }",
    "}"
  ];
}

function powershellHookMetadata() {
  return [
    "try {",
    "  $hook = $raw | ConvertFrom-Json",
    "  $fields = @{ providerThreadId = @('session_id','sessionId','conversation_id'); providerTurnId = @('turn_id','turnId','generation_id'); toolId = @('tool_use_id','toolUseId','tool_call_id','call_id'); toolName = @('tool_name','toolName'); taskId = @('agent_id','subagent_id','task_id'); taskLabel = @('agent_type','subagent_type','task_name'); parentThreadId = @('parent_session_id','parentSessionId','parent_conversation_id'); transcriptPath = @('transcript_path','transcriptPath'); cwd = @('cwd') }",
    "  foreach ($field in $fields.Keys) {",
    "    foreach ($key in $fields[$field]) {",
    "      $value = $hook.$key",
    "      if ($value -is [string] -and $value.Length -gt 0 -and $value.Length -le 4096) { $payload[$field] = $value; break }",
    "    }",
    "  }",
    "  if (-not $payload['taskLabel'] -and @('Task','Agent') -contains $payload['toolName'] -and $hook.tool_input.description -is [string]) { $payload['taskLabel'] = $hook.tool_input.description.Substring(0, [Math]::Min(256, $hook.tool_input.description.Length)) }",
    "  $hookName = $hook.hook_event_name; if (-not $hookName) { $hookName = $hook.hookEventName }; if (-not $hookName) { $hookName = $hook.event }",
    "  if (@('PreToolUse','BeforeTool') -contains $hookName) { $payload['phase'] = 'start' }",
    "  if (@('PostToolUse','PostToolUseFailure','AfterTool') -contains $hookName) { $payload['phase'] = 'stop' }",
    "  if ($hook.isSidechain -eq $true -or $hook.is_sidechain -eq $true -or $hook.subagent -eq $true -or $payload['parentThreadId']) { $payload['rootVerified'] = $false }",
    "} catch {}"
  ];
}

module.exports = { hookMetadata, readHookInput, powershellReadHookInput, powershellHookMetadata };
