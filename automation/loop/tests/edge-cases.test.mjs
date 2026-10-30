import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCheckpoint, readCheckpoint, listPaused, checkpointName } from "../src/checkpoint.mjs";
import { nextPhaseForTree } from "../src/review-invariants.mjs";
import { selectRecoveryCandidates } from "../src/recovery-intent.mjs";
import { git } from "../src/process.mjs";
import { inspectChanges } from "../src/guards.mjs";

const issue = { number: 77, title: "same issue number" };
test("same issue number is isolated between GitHub and local checkpoints", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soxu-two-modes-"));
  try {
    await writeCheckpoint({issue,local:true,phase:"develop",status:"paused"},dir);
    await writeCheckpoint({issue,local:false,phase:"review",status:"paused"},dir);
    assert.equal((await readCheckpoint(77,dir,true)).phase,"develop");
    assert.equal((await readCheckpoint(77,dir,false)).phase,"review");
    assert.equal((await listPaused(dir)).length,2);
    assert.equal(checkpointName(77,true),"local-issue-77.json");
    assert.equal(checkpointName(77,false),"github-issue-77.json");
    assert.throws(()=>selectRecoveryCandidates([
      {issue,local:true,status:"paused"},{issue,local:false,status:"paused"}
    ],{scope:"issue",issueNumber:77}),/--local/);
    assert.equal(selectRecoveryCandidates(await listPaused(dir),{scope:"issue",issueNumber:77},{localOnly:true})[0].local,true);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("legacy checkpoint is read only within its original scope and migrated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soxu-legacy-"));
  try {
    await writeFile(join(dir,"issue-77.json"),JSON.stringify({issue,local:true,status:"paused",phase:"checks"}));
    assert.equal(await readCheckpoint(77,dir,false),null);
    assert.equal((await readCheckpoint(77,dir,true)).phase,"checks");
    await writeCheckpoint({issue,local:true,status:"paused",phase:"review"},dir);
    await assert.rejects(stat(join(dir,"issue-77.json")),{code:"ENOENT"});
    assert.equal((await listPaused(dir)).length,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("source edits after check or review force recheck and re-review", async () => {
  const dir = await mkdtemp(join(tmpdir(),"soxu-tree-"));
  try {
    await git(["init","-q"],dir);
    await git(["config","user.email","soxu-test@example.invalid"],dir);
    await git(["config","user.name","SOXU Test"],dir);
    await writeFile(join(dir,"a.txt"),"base\n");
    await git(["add","a.txt"],dir); await git(["commit","-qm","base"],dir);
    const base = await git(["rev-parse","HEAD"],dir);
    const policy={maxChangedFiles:80,maxChangedBytes:1500000,protectedPaths:["AGENTS.md"]};
    await writeFile(join(dir,"a.txt"),"first\n");
    await inspectChanges(dir,base,policy);
    const testedTree=await git(["write-tree"],dir);
    let state={testedTree,reviewedTree:testedTree};
    assert.equal(nextPhaseForTree("finalChecks",state,testedTree),"commit");
    // The user edits a file outside the index during review / after finalChecks.
    await writeFile(join(dir,"a.txt"),"second\n");
    await inspectChanges(dir,base,policy);
    const changedTree=await git(["write-tree"],dir);
    assert.notEqual(changedTree,testedTree);
    assert.equal(nextPhaseForTree("review",state,changedTree),"checks");
    assert.equal(nextPhaseForTree("commit",state,changedTree),"checks");
    state={testedTree:changedTree,reviewedTree:testedTree};
    assert.equal(nextPhaseForTree("finalChecks",state,changedTree),"review");
    state.reviewedTree=changedTree;
    assert.equal(nextPhaseForTree("commit",state,changedTree),"commit");
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("idle timeout terminates Pi subprocess tree, not only the coordinator", { skip: process.platform === "win32" }, async () => {
  const { runPi } = await import("../src/rpc.mjs");
  const dir = await mkdtemp(join(tmpdir(), "soxu-kill-tree-"));
  const bin = join(dir, "fake-pi");
  const marker = join(dir, "should-not-exist.txt");
  const prev = process.env.SOXU_PI_BIN;
  try {
    await writeFile(bin, `#!/usr/bin/env node
const {spawn}=require('node:child_process');
let got=false;
process.stdin.on('data',c=>{
  if(got)return;
  const m=JSON.parse(c.toString().trim());if(m.type!=='prompt')return;
  got=true;
  spawn(process.execPath,['-e','setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"orphan"),600)', ${JSON.stringify(marker)}],{stdio:'ignore'});
  process.stdout.write(JSON.stringify({type:'response',id:m.id,success:true,data:{disposition:'started'}})+'\\n');
});
`);
    const { chmod } = await import("node:fs/promises");
    await chmod(bin,0o755);
    process.env.SOXU_PI_BIN = bin;
    const err = await runPi({cwd:dir,prompt:"test",timeoutMs:4000,timeouts:{piStartupSeconds:1,piIdleSeconds:0.12,shutdownGraceSeconds:0.08}}).then(()=>null,e=>e);
    assert.equal(err.kind,"timeout");
    await new Promise(resolve=>setTimeout(resolve,850));
    await assert.rejects(stat(marker),{code:"ENOENT"});
  } finally {
    if(prev===undefined)delete process.env.SOXU_PI_BIN;else process.env.SOXU_PI_BIN=prev;
    await rm(dir,{recursive:true,force:true});
  }
});

test("watch resumes interrupted tasks the same way loop does", async () => {
  const source = await readFile(new URL("../src/cli.mjs", import.meta.url), "utf8");
  const start = source.indexOf('case "watch"');
  const end = source.indexOf('case "loop"');
  assert.ok(start > 0 && end > start, "找到 watch 分支");
  const block = source.slice(start, end);
  // 被中断的任务是 agent:paused，不在 ready 队列里；issues() 看不到它们。
  // 过去只有 loop 恢复，watch 完全不恢复，于是「挂一晚上」推不动任何中断任务。
  assert.match(block, /clearStaleRunning/, "watch 清理僵尸 running 状态");
  assert.match(block, /listPaused/, "watch 读取中断任务");
  assert.match(block, /recover\(null, \{ includeBlocked: false \}\)/, "watch 只恢复 paused，blocked 需人工确认");
  // 定义一次 + 启动时调用 + 每轮轮询前调用
  assert.ok(block.split("resumeInterrupted").length - 1 >= 3, "启动时与每轮轮询前都恢复");
});

test("watch polling wait stops promptly when interrupted", async () => {
  const { interruptibleWait } = await import("../src/interruptible-wait.mjs");
  const controller = new AbortController();
  const start = Date.now();
  setTimeout(()=>controller.abort(),25);
  assert.equal(await interruptibleWait(60000,controller.signal),false);
  assert.ok(Date.now()-start < 1000);
  assert.equal(await interruptibleWait(60000,controller.signal),false);
  assert.equal(await interruptibleWait(1,new AbortController().signal),true);
});
