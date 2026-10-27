
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectWorktrees, prepareWorktreeRecovery } from "../src/worktree-sync.mjs";
import { readCheckpoint, writeCheckpoint } from "../src/checkpoint.mjs";
import { ROOT, TOOL_ROOT } from "../src/config.mjs";

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run("git", args, { cwd, timeout: 10000 })).stdout.trim();
async function fixture() {
  const outer = await mkdtemp(join(tmpdir(), "soxu-worktree-audit-"));
  const root = join(outer, "soxu");
  await mkdir(root);
  await git(root, "init", "--initial-branch=main");
  await writeFile(join(root, "file.txt"), "v1");
  await git(root, "add", "file.txt");
  await git(root, "-c", "user.name=Tester", "-c", "user.email=test@example.org", "commit", "-m", "initial");
  await git(root, "remote", "add", "origin", root);
  await git(root, "fetch", "origin", "main");
  const old = await git(root, "rev-parse", "HEAD");
  const wt = join(outer, "soxu-worktrees", "github-issue-1-example");
  await git(root, "worktree", "add", "-b", "agent/github-issue-1-example", wt, old);
  const state = { issue: { number:1, title:"Example", body:"" }, local:false,
    status:"paused", phase:"develop", directory:wt, branch:"agent/github-issue-1-example",
    base:old, attempt:0 };
  const dir = join(root, ".soxu", "checkpoints");
  await writeCheckpoint(state, dir);
  await writeFile(join(root, "file.txt"), "v2");
  await git(root, "add", "file.txt");
  await git(root, "-c", "user.name=Tester", "-c", "user.email=test@example.org", "commit", "-m", "next");
  await git(root, "fetch", "origin", "main");
  return { outer, root, wt, old, state, dir };
}
test("clean paused worktree syncs with new main and updates base", async () => {
  const f = await fixture();
  try {
    let rows = await inspectWorktrees({ root:f.root });
    if (rows[0].reason === "worktree-identity-mismatch") console.error("worktree diagnostic", JSON.stringify({expected:f.wt, top:await git(f.wt,"rev-parse","--show-toplevel"), branch:await git(f.wt,"branch","--show-current"), expectedBranch:f.state.branch}));
    assert.equal(rows[0].behind, 1);
    assert.equal(rows[0].canSync, true);
    rows = await inspectWorktrees({ root:f.root, sync:true });
    assert.equal(rows[0].reason, "synced");
    const saved = await readCheckpoint(1, f.dir);
    assert.equal(saved.base, await git(f.root, "rev-parse", "origin/main"));
    assert.equal(saved.phase, "install");
    assert.equal(saved.syncPending, undefined);
    assert.equal(await git(f.wt, "rev-parse", "HEAD"), saved.base);
  } finally { await rm(f.outer, { recursive:true, force:true }); }
});
test("dirty task edits survive nonconflicting main fast-forward with saved stash backup", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.wt, "untracked.txt"), "irreplaceable");
    assert.equal((await inspectWorktrees({ root:f.root, sync:true }))[0].reason, "synced");
    const state = await readCheckpoint(1, f.dir);
    assert.equal(state.base, await git(f.root, "rev-parse", "origin/main"));
    assert.equal(state.phase, "install");
    assert.match(state.syncBackup.sha, /^[a-f0-9]{40,64}$/);
    assert.equal(await git(f.wt, "rev-parse", "HEAD"), state.base);
    assert.equal(await readFile(join(f.wt, "untracked.txt"), "utf8"), "irreplaceable");
    assert.match(await git(f.wt, "stash", "show", "-p", "--include-untracked", state.syncBackup.sha), /irreplaceable/);
  } finally { await rm(f.outer, { recursive:true, force:true }); }
});
test("active lock and committed checkpoint block synchronization", async () => {
  const f = await fixture();
  try {
    const locks = join(f.root, ".soxu", "locks");
    await mkdir(locks, { recursive:true });
    await writeFile(join(locks, "github-issue-1.lock"), JSON.stringify({pid:process.pid}));
    assert.equal((await inspectWorktrees({ root:f.root, sync:true }))[0].reason, "worktree-locked");
    await rm(join(locks, "github-issue-1.lock"));
    await writeCheckpoint({ ...f.state, phase:"push", commit:"example" }, f.dir);
    assert.equal((await inspectWorktrees({ root:f.root, sync:true }))[0].reason, "advanced-phase");
    assert.equal(await git(f.wt, "rev-parse", "HEAD"), f.old);
  } finally { await rm(f.outer, { recursive:true, force:true }); }
});
test("interrupted fast-forward completes recorded sync intent safely", async () => {
  const f = await fixture();
  try {
    const target = await git(f.root, "rev-parse", "origin/main");
    await writeCheckpoint({ ...f.state, syncPending:{from:f.old,to:target} }, f.dir);
    await git(f.wt, "merge", "--ff-only", target);
    assert.equal((await inspectWorktrees({ root:f.root, sync:true }))[0].reason, "synced");
    const state = await readCheckpoint(1, f.dir);
    assert.equal(state.base, target);
    assert.equal(state.syncPending, undefined);
  } finally { await rm(f.outer, { recursive:true, force:true }); }
});

test("explicit selection cannot update unrelated task checkpoints",async()=>{
  const f=await fixture();
  try{
    assert.deepEqual(await inspectWorktrees({root:f.root,sync:true,issueNumbers:[{id:2,local:false}]}),[]);
    assert.equal(await git(f.wt,"rev-parse","HEAD"),f.old);
    assert.equal((await inspectWorktrees({root:f.root,sync:true,issueNumbers:[{id:1,local:false}]}))[0].reason,"synced");
  }finally{await rm(f.outer,{recursive:true,force:true});}
});


test("conflicting task edits are backed up and delegated to autonomous Developer", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.wt, "file.txt"), "task implementation\n");
    await git(f.wt, "add", "file.txt");
    const rows = await inspectWorktrees({ root:f.root, sync:true });
    assert.equal(rows[0].reason, "synced-conflicts");
    const state = await readCheckpoint(1, f.dir);
    assert.equal(state.base, await git(f.root, "rev-parse", "origin/main"));
    assert.equal(await git(f.wt, "rev-parse", "HEAD"), state.base);
    assert.equal(state.phase, "develop");
    assert.ok(state.mergeConflict?.stashSha);
    assert.match(await git(f.wt, "stash", "show", "-p", state.mergeConflict.stashSha), /task implementation/);
    assert.match(state.feedback, /Resolve worktree\/main conflicts/);
    // A second recovery must not replay the stash or destroy preserved conflict state.
    const eligible = await prepareWorktreeRecovery([{issue:{number:1},local:false}],{root:f.root});
    assert.equal(eligible.blocked.length,0);
    assert.equal(eligible.eligible.length,1);
    assert.equal((await readCheckpoint(1,f.dir)).mergeConflict.stashSha,state.mergeConflict.stashSha);
  } finally { await rm(f.outer,{recursive:true,force:true}); }
});
test("interrupted stash creation is replayed from its recorded marker", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.wt, "restorable.txt"), "saved progress");
    const marker="soxu-main-sync-1-test-replay";
    await writeCheckpoint({...f.state,syncPending:{mode:"dirty",from:f.old,to:await git(f.root,"rev-parse","origin/main"),marker}},f.dir);
    await git(f.wt,"stash","push","--include-untracked","-m",marker);
    const rows=await inspectWorktrees({root:f.root,sync:true});
    assert.equal(rows[0].reason,"synced");
    assert.equal(await readFile(join(f.wt,"restorable.txt"),"utf8"),"saved progress");
    assert.equal((await readCheckpoint(1,f.dir)).syncPending,undefined);
  } finally { await rm(f.outer,{recursive:true,force:true}); }
});
test("crash after stash apply preserves current worktree and asks Developer to verify backup", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.wt,"working.txt"),"old work");
    const marker="soxu-main-sync-1-verify-after-apply";
    const target=await git(f.root,"rev-parse","origin/main");
    await writeCheckpoint({...f.state,syncPending:{mode:"dirty",from:f.old,to:target,marker}},f.dir);
    await git(f.wt,"stash","push","--include-untracked","-m",marker);
    await git(f.wt,"merge","--ff-only",target);
    const sha=(await git(f.wt,"stash","list","--format=%H")).split("\n")[0];
    await git(f.wt,"stash","apply","--index",sha);
    const result=await inspectWorktrees({root:f.root,sync:true});
    assert.equal(result[0].reason,"synced-conflicts");
    assert.equal(await readFile(join(f.wt,"working.txt"),"utf8"),"old work");
    assert.equal((await readCheckpoint(1,f.dir)).mergeConflict.stashSha,sha);
  } finally { await rm(f.outer,{recursive:true,force:true}); }
});

test("worktree CLI has shebang at byte zero and compiles as Node ESM", async () => {
  const filename = join(TOOL_ROOT, "automation", "loop", "src", "worktree-sync-cli.mjs");
  const content = await readFile(filename, "utf8");
  assert.ok(content.startsWith("#!/usr/bin/env node\n"), "shebang must be first line without leading newline or BOM");
  await run(process.execPath, ["--check", filename], { cwd: ROOT, timeout: 10000 });
});

test("checkpoint at review/postConflictInstall may resume when already on latest main",async()=>{
  const f=await fixture();
  try{
    await git(f.wt,"merge","--ff-only","origin/main");
    const base=await git(f.wt,"rev-parse","HEAD");
    for(const phase of ["review","postConflictInstall"]){
      await writeCheckpoint({...f.state,base,phase,testedTree:phase==="review"?"reviewed-tree":null},f.dir);
      const rows=await inspectWorktrees({root:f.root});
      assert.equal(rows[0].reason,"up-to-date");
      const recovered=await prepareWorktreeRecovery([{issue:{number:1},local:false}],{root:f.root});
      assert.equal(recovered.blocked.length,0);
    }
  }finally{await rm(f.outer,{recursive:true,force:true});}
});

 test("blocked review sync preserves edits and invalidates prior evidence", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.wt, "task.txt"), "task progress");
    await git(f.wt, "add", "task.txt");
    await writeCheckpoint({ ...f.state, status:"blocked", phase:"review", testedTree:"old", reviewedTree:"old" }, f.dir);
    assert.equal((await inspectWorktrees({root:f.root, sync:true}))[0].reason, "synced");
    const saved = await readCheckpoint(1, f.dir);
    assert.equal(saved.phase, "recoveryInstall");
    assert.equal(saved.testedTree, null);
    assert.equal(saved.reviewedTree, null);
    assert.equal(await readFile(join(f.wt, "task.txt"), "utf8"), "task progress");
    assert.ok(saved.syncBackup.sha);
  } finally { await rm(f.outer, {recursive:true, force:true}); }
});
