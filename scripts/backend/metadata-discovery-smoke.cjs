const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { findCodexThread, confirmCodexThread, listCodexThreads } = require("../../backend/agentThreads.cjs");
const { parseClaudeTranscript, confirmClaudeThread, confirmKimiThread, confirmQwenThread, qwenChatsDir, findLatestAgentThread } = require("../../backend/agentThreadHost.cjs");
const { parseGeminiTranscript, lookupGeminiThread } = require("../../backend/geminiThreads.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-metadata-"));
const cwd = path.join(root, "repo");
const codexHome = path.join(root, "codex");
const geminiHome = path.join(root, "gemini");
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
function write(file, data, jsonl = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl ? data.map((record) => JSON.stringify(record)).join("\n") + "\n" : JSON.stringify(data, null, 2));
  return file;
}
async function main() {
  fs.mkdirSync(cwd);
  const rollout = (id, extra = {}) => write(path.join(codexHome, "sessions", `rollout-time-${id}.jsonl`), [
    {type:"session_meta", payload:{id,cwd,timestamp:"2026-09-01T00:00:00Z", ...extra}},
    {type:"event_msg", payload:{type:"user_message",message:"Initial preview"}}
  ]);
  rollout(first);
  rollout(second, { source: { subagent: { thread_spawn: { parent_thread_id: first } } } });
  rollout("parent-field", { parent_thread_id: first });
  const index = path.join(codexHome, "session_index.jsonl");
  write(index, [{id:first,thread_name:"Old saved name"},{id:second,thread_name:"Child name"},{id:first,thread_name:"Latest saved name"}]);
  assert.equal(findCodexThread({cwd},{codexHome}).threadRef.title, "Latest saved name");
  assert.equal(listCodexThreads({cwd},{codexHome}).threads.length, 1);
  assert.equal(confirmCodexThread(cwd, second,{codexHome}).status,"missing");
  assert.equal(confirmCodexThread(cwd, first,{codexHome}).threadRef.titleSource,"named");
  assert.equal(confirmCodexThread(cwd, first,{codexHome}).rootVerified,true);
  assert.equal(confirmCodexThread(path.join(root,"foreign"), first,{codexHome}).rootVerified,false);
  const malformed=path.join(codexHome,"sessions","rollout-time-malformed.jsonl");
  fs.writeFileSync(malformed,'{"type":');
  assert.equal(confirmCodexThread(cwd,"malformed",{codexHome}).status,"found");
  assert.equal(confirmCodexThread(cwd,"malformed",{codexHome}).rootVerified,false);
  fs.appendFileSync(index, JSON.stringify({id:first,thread_name:"Renamed again"})+"\n");
  assert.equal(confirmCodexThread(cwd, first,{codexHome}).threadRef.title,"Renamed again");

  const claude = write(path.join(root,"claude.jsonl"), [
    {sessionId:first,cwd,timestamp:"2026-09-01T00:00:00Z",type:"user",message:{content:"Prompt preview"}},
    {type:"custom-title",customTitle:"First name"},
    ...Array.from({length:50},()=>({type:"assistant",message:{content:"filler"}})),
    {type:"custom-title",customTitle:"Latest custom name"},
    {type:"ai-title",aiTitle:"Generated name"}
  ]);
  assert.equal(parseClaudeTranscript(claude,cwd).title,"Latest custom name");
  assert.equal(parseClaudeTranscript(claude,cwd).titleSource,"named");
  fs.appendFileSync(claude, JSON.stringify({type:"custom-title",customTitle:"Live rename"})+"\n");
  assert.equal(parseClaudeTranscript(claude,cwd).title,"Live rename");

  const generatedClaude = write(path.join(root,"claude-generated.jsonl"), [
    {sessionId:second,cwd,timestamp:"2026-09-01T00:00:00Z",type:"user",message:{content:"First prompt"}},
    {type:"ai-title",aiTitle:"Earlier generated title"},
    ...Array.from({length:50},()=>({type:"assistant",message:{content:"x".repeat(6000)}})),
    {type:"ai-title",aiTitle:"Latest generated title"}
  ]);
  assert.equal(parseClaudeTranscript(generatedClaude,cwd).title,"Latest generated title");
  assert.equal(parseClaudeTranscript(generatedClaude,cwd).titleSource,"generated");
  const sidechain = write(path.join(root,"claude-sidechain.jsonl"), [{sessionId:first,cwd,isSidechain:true}]);
  assert.equal(parseClaudeTranscript(sidechain,cwd),null);

  const previousClaudeHome=process.env.CLAUDE_CONFIG_DIR;
  const fixtureClaudeHome=path.join(root,"claude-home");
  process.env.CLAUDE_CONFIG_DIR=fixtureClaudeHome;
  try {
    write(path.join(fixtureClaudeHome,"projects","fixture",`${first}.jsonl`),[{sessionId:first,cwd,type:"user",message:{content:"Root"}}]);
    assert.equal(confirmClaudeThread(cwd,first).rootVerified,true);
    assert.equal(confirmClaudeThread(path.join(root,"foreign"),first).rootVerified,false);
    write(path.join(fixtureClaudeHome,"projects","fixture",`${second}.jsonl`),[]);
    assert.equal(confirmClaudeThread(cwd,second).status,"found");
    assert.equal(confirmClaudeThread(cwd,second).rootVerified,false);
  } finally {
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR=previousClaudeHome;
  }
  const hash=crypto.createHash("sha256").update(cwd).digest("hex");
  const meta={sessionId:first,projectHash:hash,startTime:"2026-09-01T00:00:00Z",lastUpdated:"2026-09-02T00:00:00Z"};
  const file=write(path.join(geminiHome,"tmp","repo-slug","chats","session-first.jsonl"),[
    meta,{id:"u1",type:"user",content:"/command"},{id:"u2",type:"user",content:[{text:"Meaningful prompt"}]},
    {$set:{summary:"Early summary"}},{$set:{summary:"Current summary"}}
  ]);
  assert.equal(parseGeminiTranscript(file,cwd).title,"Current summary");
  assert.equal(parseGeminiTranscript(file,cwd).titleSource,"generated");
  assert.equal(parseGeminiTranscript(file,path.join(root,"wrong")),null);
  assert.equal(parseGeminiTranscript(file,cwd,{sessionId:second}),null);
  assert.equal(lookupGeminiThread({cwd},{geminiHome}).threadRef.id,first);
  assert.equal(lookupGeminiThread({cwd,confirmId:first},{geminiHome}).rootVerified,true);
  fs.appendFileSync(file, JSON.stringify({$set:{name:"Named session"}})+"\n");
  assert.equal(lookupGeminiThread({cwd,confirmId:first},{geminiHome}).threadRef.title,"Named session");
  const legacy=write(path.join(geminiHome,"tmp","legacy","chats","session-second.json"),{...meta,sessionId:second,messages:[{id:"u1",type:"user",content:"?help"},{id:"u2",type:"user",content:"Legacy real prompt"}]},false);
  assert.equal(parseGeminiTranscript(legacy,cwd).title,"Legacy real prompt");
  assert.equal(lookupGeminiThread({cwd},{geminiHome}).status,"ambiguous");
  assert.equal(lookupGeminiThread({cwd,list:true},{geminiHome}).threads.length,2);
  assert.equal(lookupGeminiThread({cwd,excludeIds:[second]},{geminiHome}).threadRef.id,first);
  const child=write(path.join(geminiHome,"tmp","child","chats","session-child.jsonl"),[{...meta,kind:"subagent"}]);
  assert.equal(parseGeminiTranscript(child,cwd),null);
  assert.equal(lookupGeminiThread({cwd,sessionId:first,transcriptPath:child},{geminiHome}).threadRef.id,first);
  assert.equal((await findLatestAgentThread({provider:"gemini",cwd,sessionId:first,transcriptPath:file})).threadRef.title,"Named session");
  assert.equal(lookupGeminiThread({cwd,confirmId:first.slice(0,8)},{geminiHome}).status,"missing");
  // Slug registry ownership supports renamed/migrated project stores without
  // assigning an unrelated project's lone transcript by timestamp.
  const slugId="33333333-3333-4333-8333-333333333333";
  write(path.join(geminiHome,"projects.json"),{projects:{[cwd]:"registered-slug"}},false);
  write(path.join(geminiHome,"tmp","registered-slug","chats","session-slug.jsonl"),[{...meta,sessionId:slugId,projectHash:"old-platform-hash"}]);
  assert.equal(lookupGeminiThread({cwd,confirmId:slugId},{geminiHome}).threadRef.id,slugId);
  fs.writeFileSync(path.join(geminiHome,"tmp","registered-slug",".project_root"),path.join(root,"foreign"));
  assert.equal(lookupGeminiThread({cwd,confirmId:slugId},{geminiHome}).status,"missing");
  const corrupt=write(path.join(geminiHome,"tmp","corrupt","chats","session-corrupt.jsonl"),[]);
  fs.appendFileSync(corrupt,'{"sessionId":');
  assert.equal(lookupGeminiThread({cwd,confirmId:slugId},{geminiHome}).status,"pending");
  const kimiHome=path.join(root,"kimi-proof");
  const kimiDir=path.join(kimiHome,"sessions",first);
  write(path.join(kimiDir,"state.json"),{title:"Kimi root",createdAt:meta.startTime,workDir:cwd},false);
  write(path.join(kimiHome,"session_index.jsonl"),[{sessionId:first,sessionDir:kimiDir,workDir:cwd}]);
  assert.equal(confirmKimiThread(cwd,first,{home:kimiHome}).rootVerified,true);
  assert.equal(confirmKimiThread(path.join(root,"foreign"),first,{home:kimiHome}).rootVerified,false);
  fs.writeFileSync(path.join(kimiDir,"state.json"),'{"title":');
  assert.equal(confirmKimiThread(cwd,first,{home:kimiHome}).rootVerified,false);
  const previousQwenHome=process.env.QWEN_HOME;
  process.env.QWEN_HOME=path.join(root,"qwen-proof");
  try {
    const qwenFile=write(path.join(qwenChatsDir(cwd),`${first}.jsonl`),[{sessionId:first,cwd,timestamp:meta.startTime,type:"user",message:{parts:[{text:"Qwen root"}]}}]);
    assert.equal(confirmQwenThread(cwd,first).rootVerified,true);
    write(qwenFile,[{sessionId:first,parentSessionId:second,cwd,timestamp:meta.startTime,type:"user",message:{parts:[{text:"Child"}]}}]);
    assert.equal(confirmQwenThread(cwd,first).rootVerified,false);
    fs.writeFileSync(qwenFile,'{"sessionId":');
    assert.equal(confirmQwenThread(cwd,first).status,"found");
    assert.equal(confirmQwenThread(cwd,first).rootVerified,false);
  } finally {
    if (previousQwenHome === undefined) delete process.env.QWEN_HOME;
    else process.env.QWEN_HOME=previousQwenHome;
  }
  const caps=require("../../shared/providerCapabilities.json");
  assert.deepEqual(Object.keys(caps).sort(),["terminal","codex","claude","cursor","gemini","opencode","kimi","kimi-custom","qwen"].sort());
  assert.equal(caps.gemini.finalCompletion,"coarse");
  console.log("Metadata discovery smoke passed: saved/live titles, root exclusion, Gemini formats/ownership/resume, capability registry.");
}
main().catch((error)=>{ console.error(error); process.exitCode=1; }).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
