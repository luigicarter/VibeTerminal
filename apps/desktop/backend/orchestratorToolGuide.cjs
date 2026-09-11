'use strict';

// One compact catalog per request, filtered by the same schema the model sees.
// This describes tools; frozen grants and runtime validators remain authoritative.
const operations = {
  find_agents: 'Find agent records by project/task/state; bounded pages with nextCursor. Does not read transcripts or select an owner.',
  read_agent: 'Selected agent sections: identity/work/activity/attention/capabilities/notes/results/history; nextCursor for more.',
  read_agent_history: 'Read/search the exact agent conversation on demand; native source identity must match.',
  read_work_item: 'Full stored task objective/constraints and ownership references; history alone gives no action authority.',
  record_agent_note: 'Store a concise inferred finding or handoff for an agent read in this request. No terminal input or runtime-state changes.',
  read_file: 'UTF-8 workspace file; nextCursor+reference for more; maxChars<=4000 bytes.',
  read_workspace: 'View, projects, activity, Orchestrator config and capability limits.',
  list_roots: 'Allowed roots.',
  list_sessions: 'Live terminals; query/provider/cwd; nextOffset.',
  read_session: 'Live output/questions, provider navigation guide, fresh action evidence; maxChars<=4000. beforeSequence: older output, no action token.',
  list_conversations: 'Saved identities; provider/cwd/query; nextOffset.',
  read_conversation: 'Saved reference text; maxChars<=4000; nextCursor.',
  search_conversation: 'Text query in saved reference; limit<=8; nextCursor.',
  search_files: 'Filename/directory substring, not file contents; narrow root/query if truncated; no cursor.',
  list_work: 'Durable task status/results; cwd/query; limit<=10; nextOffset.',
  list_setups: 'Saved setups.',
  read_setup: 'Named setup contents.',
  list_preferences: 'Saved preferences.',
  watch_terminal: 'Register completion/readiness notification for existing work; sends no input.',
  navigate: 'Show an authorized app view/project.',
  focus_session: 'Reveal a terminal only when needed by the user workflow.',
  stage_draft: 'Save the authorized unsent draft.',
  send_prompt: 'Deliver and submit the authorized task; no extra Enter. Busy targets can queue it.',
  terminal_interact: 'Observed native controls; text/keys/mouse; submit OR final Enter; inputPurpose task starts tracked work.',
  answer_question: 'Answer current structured requestId/revision; answerTexts maps every question ID for multiple questions.',
  permission: 'Decide current requestId/revision within permissionMode; delegated decisions are once/reject.',
  finish_terminal: 'Close the observed interaction with text/outcome and fresh token/stepId; not proof delegated work succeeded.',
  interrupt: 'Interrupt only with authorized lifecycle scope.',
  restart: 'Restart the authorized target.',
  close: 'Close the authorized target.',
  create_session: 'Create the bound terminal; text is an unsent draft, not task execution.',
  resume_conversation: 'Resume an exact discovered/confirmed saved reference within the grant.',
  create_project: 'Create the bound project folder under parent/name.',
  open_folder: 'Reveal the authorized folder in the file manager.',
  remove_project: 'Remove the bound project from Lina and close its panes; keep all files.',
  add_project: 'Add the authorized existing project path.',
  launch_setup: 'Launch the authorized named setup.',
  save_setup: 'Save the authorized named setup.',
  remember_preference: 'Store the authorized preference text.',
  forget_preference: 'Remove the authorized preferenceId.',
  ask_user: 'Missing knowledge/authority; reference+grantId confirms a resume candidate.',
  respond: 'Final text; responseTurn listen/complete/dismiss; speechText spoken summary.',
};

const policy = `Reuse context identities/roots/preferences/receipts. At most 6 workspace calls per response, executed in order; batch known independent arguments. Unseen token/revision/cursor/answer dependencies wait for results. ask_user/respond alone or last. Shared read allowance: read-step-limit means next model round; retrySamePage/retrySmallerPage means same cursor/offset, smaller page. Truncation is not absence. List pages use offset/limit and returned nextOffset; transcript pages use returned nextCursor. Tracked delegated work uses app monitoring: do not poll or replay; report pending results.`;
const actionPolicy = ' Batch authorized actions with known evidence; effect+post-read may share a response, subsequent input waits for fresh evidence. Do not focus merely to read or send. Continue remaining authorized grants; use delegated judgment within scope; verify effects. Ask only for missing knowledge/authority.';

function workspaceToolGuide(tool) {
  const kinds = tool.function.parameters.properties.kind.enum;
  return `${policy}${kinds.some(kind => ['send_prompt', 'terminal_interact', 'finish_terminal'].includes(kind)) ? actionPolicy : ''}\nAvailable workspace operations:\n${kinds.map(kind => {
    if (!Object.hasOwn(operations, kind)) throw new Error(`Missing workspace tool guidance for ${kind}.`);
    return `${kind}: ${operations[kind]}`;
  }).join('\n')}`;
}

module.exports = { workspaceToolGuide, workspaceOperationGuide: kind => operations[kind] };
