import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm,access,open} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {run} from "../src/process.mjs";
import {writeCheckpoint,readCheckpoint} from "../src/checkpoint.mjs";
import {cleanupMergedTasks,selectOrphanTasks} from "../src/merged-cleanup.mjs";

async function fixture(fn){const tmp=await mkdtemp(join(tmpdir(),"soxu-cleanup-")),root=join(tmp,"repo"),wt=join(tmp,"soxu-worktrees","github-issue-1-example"),remote=join(tmp,"remote.git"),branch="agent/github-issue-1-example";
 const git=async(args,cwd=root)=>run("git",args,{cwd});
 try {await mkdir(root);await git(["init","--bare",remote],tmp);await git(["init","-b","main"]);await git(["config","user.email","test@example.com"]);await git(["config","user.name","Test"]);await writeFile(join(root,".gitignore"),"node_modules/\ntarget/\ndist/\n.env\n");await git(["add",".gitignore"]);await git(["commit","-m","initial"]);await git(["remote","add","origin",remote]);await git(["push","-u","origin","main"]);await mkdir(join(tmp,"soxu-worktrees"));await git(["worktree","add","-b",branch,wt,"main"]);await writeFile(join(wt,"change"),"change");await git(["add","change"],wt);await git(["commit","-m","feature"],wt);const sha=(await git(["rev-parse","HEAD"],wt)).stdout.trim();await git(["push","origin",branch],wt);
 const state={issue:{number:1},local:false,status:"done",phase:"done",branch,commit:sha,directory:wt,pr:"https://github.com/a/b/pull/2"};await writeCheckpoint(state,join(root,".soxu","checkpoints"));let pr={state:"MERGED",mergedAt:"2026-01-01T00:00:00Z",baseRefName:"main",headRefName:branch,headRefOid:sha,isCrossRepository:false};
 const execute=async(bin,args,opts)=>bin==="gh"?{code:0,stdout:JSON.stringify(args[0]==="repo"?{nameWithOwner:"a/b"}:pr)}:["remote get-url origin","remote get-url --push origin"].includes(args.join(" "))?{code:0,stdout:"https://github.com/a/b.git\n"}:run(bin,args,opts);
 const clean=()=>cleanupMergedTasks(root,{execute,log:()=>{}});
 await fn({root,wt,remote,branch,sha,state,git,clean,setPr:x=>{pr={...pr,...x};}});
 }finally{await rm(tmp,{recursive:true,force:true,maxRetries:5});}}
test("merged task removes clean worktree and both exact branch refs; repeat is safe",()=>fixture(async x=>{await mkdir(join(x.wt,"node_modules"));await writeFile(join(x.wt,"node_modules","generated"),"cache");await mkdir(join(x.wt,"target"));await writeFile(join(x.wt,"target","build"),"cache");const [result]=await x.clean();assert.equal(result.status,"cleaned");await assert.rejects(()=>access(x.wt));const local=await run("git",["show-ref","--verify",`refs/heads/${x.branch}`],{cwd:x.root,allowFailure:true});assert.notEqual(local.code,0);assert.equal((await x.git(["ls-remote","--heads","origin",`refs/heads/${x.branch}`])).stdout.trim(),"");assert.deepEqual(await x.clean(),[]);}));
test("dirty and ignored user data preserve local worktree and branch",()=>fixture(async x=>{await writeFile(join(x.wt,".env"),"private");const [r]=await x.clean();assert.equal(r.local,"dirty");await access(join(x.wt,".env"));await x.git(["show-ref","--verify",`refs/heads/${x.branch}`]);assert.equal(r.remote,"deleted");}));
test("unmerged, changed PR head and active lock preserve everything",()=>fixture(async x=>{x.setPr({state:"OPEN",mergedAt:null});assert.equal((await x.clean())[0].status,"not-verified");x.setPr({state:"MERGED",mergedAt:"now",headRefOid:"f".repeat(40)});assert.equal((await x.clean())[0].status,"not-verified");await mkdir(join(x.root,".soxu","locks"),{recursive:true});const h=await open(join(x.root,".soxu","locks","github-issue-1.lock"),"w");await h.close();assert.equal((await x.clean())[0].status,"locked");await access(x.wt);}));
test("remote ref advanced after merge is not deleted and local copy is preserved",()=>fixture(async x=>{await writeFile(join(x.wt,"change"),"more");await x.git(["add","change"],x.wt);await x.git(["commit","-m","new"],x.wt);await x.git(["push","origin",x.branch],x.wt);const [r]=await x.clean();assert.equal(r.remote,"changed");await access(x.wt);}));
test("manually removed worktree and refs are recorded as cleaned",()=>fixture(async x=>{await x.git(["worktree","remove",x.wt]);await x.git(["branch","-D",x.branch]);await x.git(["push","origin",`:${x.branch}`]);const [r]=await x.clean();assert.equal(r.status,"cleaned");assert.equal(r.local,"absent");assert.equal(r.remote,"absent");assert.deepEqual(await x.clean(),[]);}));

test("auto-closed issue (Closes #N) still gets stale agent labels cleared, once", async () => {
  const root = await mkdtemp(join(tmpdir(), "soxu-cleanup-relabel-"));
  try {
    const checkpointDir = join(root, ".soxu", "checkpoints");
    const state = {
      issue: { number: 90 }, local: false, status: "done", phase: "done",
      branch: "agent/github-issue-90-m1-task-019", commit: "b".repeat(40),
      pr: "https://github.com/a/b/pull/91",
      directory: join(root, "..", "soxu-worktrees", "github-issue-90-m1-task-019"),
      cleanup: { complete: true, remote: "absent", local: "absent", checkedAt: new Date().toISOString() },
    };
    await writeCheckpoint(state, checkpointDir);
    const calls = [];
    let closed = true;
    const execute = async (bin, args) => {
      calls.push(bin + " " + args.join(" "));
      if (args[0] === "issue" && args[1] === "view") {
        return { stdout: JSON.stringify({ state: closed ? "CLOSED" : "OPEN", labels: closed ? [{ name: "agent:blocked" }, { name: "agent:pr" }] : [] }) };
      }
      if (args[0] === "issue" && args[1] === "edit") { closed = true; return { stdout: "" }; }
      if (args[0] === "issue" && args[1] === "close") throw new Error("already-closed issue must not be closed twice");
      throw new Error("unexpected command: " + args.join(" "));
    };
    await cleanupMergedTasks(root, { execute, base: "dev", log: () => {} });
    assert.ok(calls.some(c => c.startsWith("gh issue edit 90") && c.includes("--remove-label agent:blocked")), "stale labels must be removed: " + calls.join(" | "));
    assert.ok(!calls.some(c => c.startsWith("gh issue close")), "must not close an already-closed issue");
    calls.length = 0;
    await cleanupMergedTasks(root, { execute, base: "dev", log: () => {} });
    assert.equal(calls.length, 0, "cleaned terminal state is cached in the checkpoint");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("orphan archival requires BOTH a closed issue and a merged PR citing it", () => {
  const candidates = [
    { taskId: "TASK-001", issue: 101 }, // 关闭 + 有合入 → 归档
    { taskId: "TASK-002", issue: 102 }, // 关闭但无合入 → 保留（手动关闭不等于做完）
    { taskId: "TASK-003", issue: 103 }, // 有合入但 issue 还开着 → 保留
    { taskId: "TASK-004", issue: 104 }, // 都不满足 → 保留
  ];
  const closed = new Set([101, 102, 104]);
  const merged = new Set([101, 103]);
  assert.deepEqual(selectOrphanTasks(candidates, closed, merged).map(c => c.taskId), ["TASK-001"]);
});

test("cleanup closes the issue even when the worktree was already cleaned", async () => {
  const root = await mkdtemp(join(tmpdir(), "soxu-cleanup-close-"));
  try {
    const checkpointDir = join(root, ".soxu", "checkpoints");
    const state = {
      issue: { number: 74 }, local: false, status: "done", phase: "done",
      branch: "agent/github-issue-74-m0-task-008", commit: "a".repeat(40),
      pr: "https://github.com/a/b/pull/76",
      directory: join(root, "..", "soxu-worktrees", "github-issue-74-m0-task-008"),
      cleanup: { complete: true, remote: "absent", local: "absent", checkedAt: new Date().toISOString() },
    };
    await writeCheckpoint(state, checkpointDir);
    const calls = [];
    const execute = async (bin, args) => {
      calls.push(bin + " " + args.join(" "));
      if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ state: "OPEN" }) };
      if (args[0] === "issue" && args[1] === "close") return { stdout: "" };
      throw new Error("unexpected command: " + args.join(" "));
    };
    const results = await cleanupMergedTasks(root, { execute, base: "dev", log: () => {} });
    assert.equal(results.length, 0, "already-cleaned task does no git work");
    assert.ok(calls.some(c => c.startsWith("gh issue close 74")), "issue must be closed: " + calls.join(" | "));
    assert.equal((await readCheckpoint(74, checkpointDir, false)).issueClosed, "closed");
    calls.length = 0;
    await cleanupMergedTasks(root, { execute, base: "dev", log: () => {} });
    assert.equal(calls.length, 0, "closed state is cached in the checkpoint");
  } finally { await rm(root, { recursive: true, force: true }); }
});
