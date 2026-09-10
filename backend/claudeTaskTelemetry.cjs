'use strict';

// These functions are also embedded in the passive Node observer. Keep them
// self-contained and return only native identity/state, never tool output text.
function normalizeClaudeTaskResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.agentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value.agentId)) return undefined;
  if (value.status === 'completed' && (value.isAsync === undefined || value.isAsync === false)) return { agentId: value.agentId, status: 'completed' };
  if (value.status === 'async_launched' && value.isAsync === true) return { agentId: value.agentId, status: 'async_launched', isAsync: true };
  return undefined;
}

function normalizeClaudeBackgroundTasks(value) {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const ids = new Set(), tasks = [];
  let bytes = 2;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(item.id) || ids.has(item.id) ||
        typeof item.type !== 'string' || !/^[A-Za-z][A-Za-z0-9 _-]{0,63}$/.test(item.type) ||
        !['running', 'pending'].includes(item.status)) return undefined;
    ids.add(item.id);
    const task = { id: item.id, type: item.type, status: item.status };
    // ASCII-only fields make the JSON character count its byte count. Leave
    // room for the common metadata in the callback's existing 64 KiB limit.
    bytes += JSON.stringify(task).length + 1;
    if (bytes > 16 * 1024) return undefined;
    tasks.push(task);
  }
  return tasks;
}

function claudeTaskMetadata(hook) {
  if (!hook || typeof hook !== 'object') return {};
  const output = {}, name = hook.hook_event_name || hook.hookEventName || hook.event;
  if (name === 'PostToolUse' && ['Agent', 'Task'].includes(hook.tool_name || hook.toolName)) {
    const result = normalizeClaudeTaskResult(hook.tool_response);
    if (result) output.claudeTaskResult = result;
  }
  // SubagentStop runs before its own gate settles and its registry is scoped
  // to the parent. Only a later root Stop can reconcile that parent's children.
  if (name === 'Stop' && !hook.agent_id && !hook.subagent_id && !hook.parent_session_id &&
      !hook.parentSessionId && !hook.parent_conversation_id && hook.isSidechain !== true &&
      hook.is_sidechain !== true && hook.subagent !== true) {
    const tasks = normalizeClaudeBackgroundTasks(hook.background_tasks);
    if (tasks) output.claudeBackgroundTasks = tasks;
  }
  return output;
}

// Windows has no dependency on a user-installed Node runtime. Mirror the same
// bounded native schemas in the generated PowerShell observer.
function powershellClaudeTaskMetadata() {
  return [
    "try {",
    "  if ($hookName -ceq 'PostToolUse' -and @('Agent','Task') -ccontains $payload['toolName']) {",
    "    $result = $hook.tool_response",
    "    if ($result -is [pscustomobject] -and $result.agentId -is [string] -and $result.agentId -cmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$') {",
    "      if ($result.status -ceq 'completed' -and ($null -eq $result.PSObject.Properties['isAsync'] -or ($result.isAsync -is [bool] -and $result.isAsync -eq $false))) { $payload['claudeTaskResult'] = @{ agentId = $result.agentId; status = 'completed' } }",
    "      elseif ($result.status -ceq 'async_launched' -and $result.isAsync -is [bool] -and $result.isAsync -eq $true) { $payload['claudeTaskResult'] = @{ agentId = $result.agentId; status = 'async_launched'; isAsync = $true } }",
    "    }",
    "  }",
    "  if ($hookName -ceq 'Stop' -and -not $hook.agent_id -and -not $hook.subagent_id -and $payload['transcriptKind'] -ne 'subagent' -and $payload['rootVerified'] -ne $false -and -not $payload['parentThreadId'] -and $hook.background_tasks -is [array] -and $hook.background_tasks.Count -le 256) {",
    "    $taskIds = New-Object 'System.Collections.Generic.HashSet[string]'",
    "    $tasks = New-Object 'System.Collections.Generic.List[object]'",
    "    $validTasks = $true",
    "    $taskBytes = 2",
    "    foreach ($item in $hook.background_tasks) {",
    "      if ($item -isnot [pscustomobject] -or $item.id -isnot [string] -or $item.id -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$' -or $item.type -isnot [string] -or $item.type -cnotmatch '^[A-Za-z][A-Za-z0-9 _-]{0,63}$' -or @('running','pending') -cnotcontains $item.status -or -not $taskIds.Add($item.id)) { $validTasks = $false; break }",
    "      $taskBytes += $item.id.Length + $item.type.Length + $item.status.Length + 32",
    "      if ($taskBytes -gt 16384) { $validTasks = $false; break }",
    "      [void]$tasks.Add(@{ id = $item.id; type = $item.type; status = $item.status })",
    "    }",
    "    if ($validTasks) { $payload['claudeBackgroundTasks'] = @($tasks.ToArray()) }",
    "  }",
    "} catch {}"
  ];
}

module.exports = { normalizeClaudeTaskResult, normalizeClaudeBackgroundTasks, claudeTaskMetadata, powershellClaudeTaskMetadata };
