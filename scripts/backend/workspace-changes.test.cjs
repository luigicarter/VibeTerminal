"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process");
const {parseStatus,listChanges,readChange}=require("../../backend/workspaceChanges.cjs");
test("NUL status handles spaces, renames and mixed staged changes",()=>{
  const result=parseStatus("R  new name.txt\0old name.txt\0 M a.txt\0?? new/f.txt\0");
  assert.equal(result[0].oldPath,"old name.txt");assert.equal(result[0].staged,true);assert.equal(result[2].path,"new/f.txt");
});
test("real Git new directories, binary content, staged diff and stale path rejection",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"vibe-changes-test-"));
  t.after(async()=>{assert(path.resolve(root).startsWith(path.join(os.tmpdir(),"vibe-changes-test-")));await fs.rm(root,{recursive:true,force:true});});
  const git=args=>execFileSync("git",args,{cwd:root,windowsHide:true,stdio:"ignore"});git(["init"]);
  await fs.mkdir(path.join(root,"new folder"));await fs.writeFile(path.join(root,"new folder","hello.txt"),"hello\n");
  await fs.writeFile(path.join(root,"binary.bin"),Buffer.from([0,1,2]));
  let list=await listChanges(root);assert(list.files.some(f=>f.path==="new folder/hello.txt"));
  assert.equal((await readChange(root,"new folder/hello.txt")).unstagedDiff,"hello\n");
  assert((await readChange(root,"binary.bin")).unstagedDiff.includes("Binary"));
  git(["add","--","new folder/hello.txt"]);const staged=await readChange(root,"new folder/hello.txt");assert(staged.stagedDiff.includes("+hello"));
  await assert.rejects(()=>readChange(root,"../outside"),/not in the current change list/);
});
