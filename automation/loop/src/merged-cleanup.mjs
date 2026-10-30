import { dataRoot } from "./config.mjs";
import { open, readFile, readdir, rm, lstat, realpath, mkdir, access } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { run } from "./process.mjs";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.mjs";
import { taskIdFromIssueTitle } from "./task-catalog.mjs";
import { runnerStatus } from "./runner-state.mjs";
import {
  archiveCommitSubject,
  closingReferences,
  orphanArchiveCommitSubject,
  STALE_AFTER_MERGE_LABELS,
} from "./rules.mjs";
const samePath = (a,b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

// Cleanup is restricted to Runner-owned GitHub tasks with an exact merged PR head.
/** 合入集成分支后关闭 Issue（幂等；结果缓存在检查点里，避免每轮都问 GitHub）。 */
async function closeMergedIssue(exec, state, n, base) {
  // "closed"：本函数关闭并已清标签；"already-closed-clean"：GitHub 自动关闭后已补清标签。
  // 两种终态都不再重复查询 GitHub；中间态 "already-closed" 只存在于旧检查点，会再查一次。
  if (state.issueClosed === "closed" || state.issueClosed === "already-closed-clean") return "cached";
  try {
    // 一次调用同时取 state 与 labels：PR 正文的 Closes #N 会让 GitHub 自动关闭 Issue，
    // 那条路径不经过本函数，旧版因此在已关闭 Issue 上残留 agent:* 标签
    // （需要人工清理，见 2026-11-02 的 8 个 Issue）。标签清理必须与关闭动作解耦。
    const view = JSON.parse((await exec("gh", ["issue", "view", String(n), "--json", "state,labels"])).stdout);
    const stale = (view.labels ?? []).map(x => x.name).filter(name => STALE_AFTER_MERGE_LABELS.includes(name));
    if (stale.length) await exec("gh", ["issue", "edit", String(n), ...stale.flatMap(name => ["--remove-label", name])]);
    if (view.state !== "OPEN") {
      state.issueClosed = "already-closed-clean";
      return "already-closed";
    }
    await exec("gh", ["issue", "close", String(n), "--comment", `已合入集成分支 ${base}；release 发布到 main 后随版本生效。`]);
    state.issueClosed = "closed";
    return "closed";
  } catch { return "unknown"; }
}
/**
 * 把任务文件从 tasks/backlog 归档到 tasks/done。
 *
 * 过去 cleanup 只删分支、删 worktree、关 issue，从不移动任务文件，
 * 于是「PR 已合并」与「依赖检查读 tasks/done」长期对不上：
 * 任务明明已经合入，依赖它的需求却仍被判为依赖缺失。
 *
 * 用 git mv + commit，避免留下未提交变更干扰后续 agent 的基点。
 * 已经归档或文件不存在时静默跳过。
 */
async function taskIdForIssue(root, state, issueNumber) {
  // 1. issue 标题里带 [TASK-NNN]（新任务都是这种格式）
  const fromTitle = taskIdFromIssueTitle(state?.issue?.title ?? "");
  if (fromTitle) return fromTitle;
  // 2. 退回 frontmatter 里的 githubIssue 反查（早期标题没有 TASK 前缀，如 #112）
  for (const dir of ["backlog", "done"]) {
    let files;
    try { files = await readdir(join(root, "tasks", dir)); } catch { continue; }
    for (const f of files) {
      if (!/^TASK-\d+\.md$/.test(f)) continue;
      try {
        const text = await readFile(join(root, "tasks", dir, f), "utf8");
        if (new RegExp(`^githubIssue:\\s*${issueNumber}$`, "m").test(text)) return f.slice(0, -3);
      } catch { /* 跳过不可读文件 */ }
    }
  }
  return null;
}

async function archiveTaskFile(root, exec, state, issueNumber, { deferWhenRunnerActive = false } = {}) {
  // 归档会往集成分支提交一个 commit。若有 runner 正在跑，它的 worktree 基点
  // 可能还是旧 commit，提交会让它下次同步时撞车。
  // 只在 dashboard 的独立定时器里跳过；runner 内部的 cleanup 自己就是那个 runner，不能跳。
  if (deferWhenRunnerActive) {
    try {
      const status = await runnerStatus(root);
      if (status?.active) return { skipped: "runner-active" };
    } catch { /* 读不到 runner 状态就按空闲处理 */ }
  }
  const taskId = await taskIdForIssue(root, state, issueNumber);
  if (!taskId) return null;
  const from = join(root, "tasks", "backlog", taskId + ".md");
  const to = join(root, "tasks", "done", taskId + ".md");
  try { await access(from); } catch { return null; }
  await mkdir(join(root, "tasks", "done"), { recursive: true });
  await exec("git", ["mv", `tasks/backlog/${taskId}.md`, `tasks/done/${taskId}.md`], { cwd: root });
  await exec("git", ["commit", "-m", archiveCommitSubject(taskId, issueNumber)], { cwd: root });
  return taskId;
}

export async function cleanupMergedTasks(root, { execute=run, log=console.log, signal, base = "main", deferWhenRunnerActive = false }={}) {
  const checkpointDir=join(dataRoot(root),"checkpoints"), lockDir=join(root,".soxu","locks");
  let files;try { files=await readdir(checkpointDir); } catch(e) {if(e.code==="ENOENT")return [];throw e;}
  const ids=[...new Set(files.map(x=>/^(?:github-)?issue-(\d+)\.json$/.exec(x)?.[1]).filter(Boolean))];
  const results=[];let repository;
  const execAtRoot=(bin,args)=>execute(bin,args,{cwd:root,timeoutMs:45000,signal});
  for(const id of ids) {
    if(signal?.aborted) break;
    const state=await readCheckpoint(Number(id),checkpointDir,false);
    if(!state || state.local) continue;
    // 已清理完成的检查点不再做 git 工作，但仍要补齐"关闭 Issue"这一步（之前因此漏关）。
    if(state.status==="done" && state.phase==="done" && state.cleanup?.complete) {
      // 历史 checkpoint 可能已经 cleanup.complete 但任务文件还留在 backlog，
      // 这里补一次归档（archiveTaskFile 内部幂等）
      try { await archiveTaskFile(root, execAtRoot, state, Number(id), { deferWhenRunnerActive }); }
      catch (e) { log(`Merged cleanup #${id}: 任务文件归档失败（${e?.message ?? e}），下次重试。`); }
      const closedState = await closeMergedIssue(execAtRoot, state, Number(id), base);
      if(closedState === "closed" || closedState === "already-closed") await writeCheckpoint(state, checkpointDir);
      continue;
    }
    if(state.status!=="done" || state.phase!=="done") continue;
    const n=Number(id), branch=state.branch, sha=state.commit;
    const match=typeof branch==="string" && new RegExp(`^agent/(?:github-issue-|issue-)${n}-([a-z0-9-]+)$`).exec(branch);
    const managed=resolve(root,"../soxu-worktrees");
    const expected=match && join(managed,`github-issue-${n}-${match[1]}`);
    if(state.issue?.number!==n || !match || !/^[0-9a-f]{40,64}$/.test(sha??"") || typeof state.pr!=="string" || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(state.pr) || !state.directory || resolve(state.directory)!==expected) {results.push({issue:n,status:"invalid-checkpoint"});continue;}
    await mkdir(lockDir,{recursive:true});const lock=join(lockDir,`github-issue-${n}.lock`);let handle;
    try {handle=await open(lock,"wx");await handle.writeFile(JSON.stringify({pid:process.pid,cleanup:true}));await handle.close();}
    catch(e){if(handle){await handle.close().catch(()=>{});await rm(lock,{force:true});}if(e.code==="EEXIST"){results.push({issue:n,status:"locked"});continue;}throw e;}
    try {
      const opts={cwd:root,timeoutMs:45000,signal};
      const exec=async(bin,args,more={})=>execute(bin,args,{...opts,...more});
      // Re-read under the same lock used by the worker; it may have changed.
      const fresh=await readCheckpoint(n,checkpointDir,false);
      if(!fresh || fresh.issue?.number!==n || fresh.status!=="done" || fresh.phase!=="done" || fresh.branch!==branch || fresh.commit!==sha || fresh.pr!==state.pr || fresh.directory!==state.directory) throw Error("checkpoint-changed");
      const repo=repository ??= JSON.parse((await exec("gh",["repo","view","--json","nameWithOwner"])).stdout).nameWithOwner;
      if(typeof repo!=="string" || !state.pr.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/pull/`)) throw Error("repository-mismatch");
      const origin=(await exec("git",["remote","get-url","origin"])).stdout.trim();
      const pushOrigin=(await exec("git",["remote","get-url","--push","origin"])).stdout.trim();
      const originMatch=/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(origin);
      const pushMatch=/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(pushOrigin);
      if(!originMatch || !pushMatch || originMatch[1].toLowerCase()!==repo.toLowerCase() || pushMatch[1].toLowerCase()!==repo.toLowerCase()) throw Error("origin-mismatch");
      const pr=JSON.parse((await exec("gh",["pr","view",state.pr,"--json","state,mergedAt,baseRefName,headRefName,headRefOid,isCrossRepository,mergeCommit"])).stdout);
      // head 与 checkpoint 不一致说明分支在任务后被推过（例如同步集成分支）；
      // 保守起见保留现场不清理，但必须把原因报出来——之前这里是静默跳过，
      // 统计只算 cleaned/preserved/errors，界面上看起来像"什么都没发生"。
      if(pr.state!=="MERGED" || !pr.mergedAt || pr.baseRefName!==base || pr.headRefName!==branch || pr.isCrossRepository!==false) {
        results.push({issue:n,status:"not-verified",reason:"pr-state"});continue;
      }
      // P0-2：人工 rebase 会改写 head，旧 sha 不再是新 head 的祖先，原先永久跳过。
      // merge 阶段已回写 mergedHead（合并后的 commit），与 PR 的 mergeCommit 一致即可放行。
      const mergedHeadRecorded = Boolean(state.mergedHead && pr.mergeCommit?.oid && state.mergedHead === pr.mergeCommit.oid);
      if(pr.headRefOid!==sha && !mergedHeadRecorded) {
        // 流程优化（2026-10-29）：人工解决集成分支冲突后 head 会偏离 checkpoint。
        // squash-merge 仓库里 checkpoint commit 不在 PR 项链上，is-ancestor 不可用；
        // 放行条件改为硬证据——PR head 的树包含 checkpoint 记录的 testedTree 所在
        // 提交的全部路径改动（用 git diff --name-only 对比两者相对 merge-base 的变更集，
        // 要求 checkpoint 的每条路径在 PR head 上都存在且内容一致），成本只读不写。
        let verified=false;
        try {
          // 1) PR head 必须包含 checkpoint 提交（内容可达）。
          const contained=await exec("git",["merge-base","--is-ancestor",sha,pr.headRefOid],{allowFailure:true});
          if(contained.code===0) verified=true;
          else {
            // 2) squash 场景：checkpoint 的树必须与 PR head 相对共同祖先的树完全一致。
            const mergeBase=(await exec("git",["merge-base",sha,pr.headRefOid])).stdout.trim();
            if(mergeBase) {
              const treeAtCp=await exec("git",["rev-parse",`${sha}^{tree}`]);
              const changesFromBase=await exec("git",["diff","--name-only",mergeBase,sha]);
              const headHasAll=await exec("git",["diff","--quiet",sha,pr.headRefOid,"--"].concat(changesFromBase.stdout.trim()?changesFromBase.stdout.trim().split("\n"):[]),{allowFailure:true});
              // PR head 在 checkpoint 改过的路径上与 checkpoint 完全一致（后续提交没回退这些文件）。
              verified=headHasAll.code===0 && treeAtCp.stdout.trim().length>0;
            }
          }
        } catch { verified=false; }
        if(!verified) {
          results.push({issue:n,status:"not-verified",reason:"head-changed"});
          log("Cleanup #"+n+": PR head "+String(pr.headRefOid).slice(0,8)+" ≠ checkpoint "+sha.slice(0,8)+"，保留现场待人工核实");
          continue;
        }
        log("Cleanup #"+n+": PR head 偏离 checkpoint（人工合并冲突），但 checkpoint 改动完整在 PR head 中，放行清理");
      }
      // head 偏离但已验明内容完整时，清理要以 PR 的实际 head 为基准，
      // 否则 remote/local 永远与 checkpoint 的旧 sha 不符 → 每轮都"保留现场"。
      const expectedHead = pr.headRefOid !== sha ? pr.headRefOid : sha;
      const remote=(await exec("git",["ls-remote","--heads","origin",`refs/heads/${branch}`])).stdout.trim();
      let remoteStatus="absent";
      if(remote){if(remote!==`${expectedHead}\trefs/heads/${branch}`) remoteStatus="changed";
      else {await exec("git",["push",`--force-with-lease=refs/heads/${branch}:${expectedHead}`,"origin",`:refs/heads/${branch}`]);remoteStatus="deleted";}}
      if(remoteStatus==="changed") {fresh.cleanup={complete:false,remote:"changed",local:"preserved",checkedAt:new Date().toISOString()};await writeCheckpoint(fresh,checkpointDir);results.push({issue:n,status:"preserved",remote:"changed",local:"preserved"});continue;}
      const listingRaw=(await exec("git",["worktree","list","--porcelain","-z"])).stdout;
      if(listingRaw.length>=990000) throw Error("worktree-list-too-large");
      const listing=listingRaw.split("\0");
      const entries=[];let entry={};for(const part of listing){if(!part){if(entry.path)entries.push(entry);entry={};}else if(part.startsWith("worktree "))entry.path=part.slice(9);else if(part.startsWith("branch "))entry.branch=part.slice(7);else if(part.startsWith("locked"))entry.locked=true;}
      const holders=entries.filter(x=>x.branch===`refs/heads/${branch}`);
      let localStatus="absent";
      const ref=await exec("git",["show-ref","--verify","--quiet",`refs/heads/${branch}`],{allowFailure:true});
      if(ref.code===0){
        const refHash=await exec("git",["show-ref","--verify","--hash",`refs/heads/${branch}`]);
        // 人工合并冲突后本地分支可能停在 checkpoint 提交（未做 merge），
        // 而 PR head 是合并后的提交；两者都代表"这条分支的工作已进集成分支"。
        const localHead=refHash.stdout.trim();
        if(localHead!==expectedHead && localHead!==sha) localStatus="changed";
        else if(holders.length>1 || holders.some(x=>x.locked) || (holders.length && !samePath(await realpath(holders[0].path),await realpath(expected)))) localStatus="other-worktree";
        else {
          if(holders.length){
            const st=await lstat(expected), parent=await lstat(managed);
            const realParent=await realpath(managed), realExpected=await realpath(expected);
            const actualRel=relative(realParent,realExpected), expectedRel=relative(managed,expected);
            const same=process.platform==="win32" ? actualRel.toLowerCase()===expectedRel.toLowerCase() : actualRel===expectedRel;
            if(!st.isDirectory() || st.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink() || !same) throw Error("unsafe-worktree-path");
            // ignored 文件分两类：构建产物（可删）与用户数据（如 .env，必须保留）。
            // 用路径白名单区分，只允许删除已知的可再生产物；
            // 白名单外的 ignored 内容一律判 dirty 并保留现场。
            const statusRaw=(await exec("git",["status","--porcelain=v1","-z","--untracked-files=normal","--ignored=matching"],{cwd:expected})).stdout;
            if(statusRaw.length>=990000) throw Error("worktree-status-too-large");
            const status=statusRaw.split("\0").filter(Boolean);
            // Tauri 项目会生成 src-tauri/gen、src-tauri/icons 等目录，之前只白名单了
            // node_modules/target/dist，导致任务完成后 worktree 永远删不掉（#38）。
            const SAFE_IGNORED=/^!! (?:[^/]+\/)*(?:node_modules|target|dist|gen|icons|coverage|out|build|\.turbo|\.next|\.cache)\/$/;
            const unsafe=status.some(x=>!SAFE_IGNORED.test(x));
            if(unsafe) localStatus="dirty";
            else {await exec("git",["worktree","remove","--force",expected]);localStatus="removed";}
          }
          if(!holders.length || localStatus==="removed") {await exec("git",["update-ref","-d",`refs/heads/${branch}`,sha]);localStatus="deleted";}
        }
      } else if(ref.code!==1) throw Error("local-ref-unavailable");
      const complete=["absent","deleted"].includes(remoteStatus) && ["absent","deleted"].includes(localStatus);
      fresh.cleanup={complete,remote:remoteStatus,local:localStatus,checkedAt:new Date().toISOString()};await writeCheckpoint(fresh,checkpointDir);
      const result={issue:n,status:complete?"cleaned":"preserved",remote:remoteStatus,local:localStatus};
      if(complete) {
      try { result.archivedTask = await archiveTaskFile(root, exec, fresh, n, { deferWhenRunnerActive }); }
      catch (e) { log(`Merged cleanup #${n}: 任务文件归档失败（${e?.message ?? e}），下次重试。`); }
      result.issueClosed = await closeMergedIssue(exec, fresh, n, base);
      if(result.issueClosed === "closed" || result.issueClosed === "already-closed") await writeCheckpoint(fresh, checkpointDir);
    }
      results.push(result);
      log(`Merged cleanup #${n}: remote=${remoteStatus}, local=${localStatus}`);
    } catch(e) {results.push({issue:n,status:"error"});log(`Merged cleanup #${n} could not be completed; the next run will retry.`);}
    finally {await rm(lock,{force:true});}
  }
  // 第二遍：孤儿任务归档。
  //
  // 上面的循环以 checkpoint 为入口，所以任务文件归档依赖 checkpoint 存在。
  // checkpoint 一旦被人工删除（或从未生成），任务就永远留在 tasks/backlog，
  // 即使 issue 早已关闭、PR 早已合并 —— 依赖检查看 tasks/done，于是后续
  // 依赖它的需求永远无法设为就绪。
  //
  // 这里直接扫 tasks/backlog：有 githubIssue 字段、issue 已关闭、且有 merged PR
  // 引用它的任务，一律归档。与 checkpoint 生命周期彻底解耦。
  try {
    const orphaned = await archiveOrphanTasks(root, execAtRoot, log, signal);
    if (orphaned.length) results.push({ status: "archived-orphans", tasks: orphaned });
  } catch (error) {
    log("Orphan task archival failed; will retry next run: " + (error?.message ?? error));
  }
  return results;
}

/**
 * 从候选里挑出可归档的：issue 已关闭 **且** 有 merged PR 引用它。
 *
 * 两个条件都要，缺一不可：
 *   - 只看 issue 关闭会误伤「手动关闭但没合入」的（#135 的教训：有人关 issue 不代表做完了）
 *   - 只看 merged PR 会漏掉 issue 还没被关的中间态
 *
 * 抽成纯函数是为了能不碰 git 就测这个判定。
 */
export function selectOrphanTasks(candidates, closed, merged) {
  return candidates.filter(c => closed.has(c.issue) && merged.has(c.issue));
}

/**
 * 归档「issue 已关闭且有合入记录」但仍留在 tasks/backlog 的任务。
 *
 * 与 archiveTaskFile 的区别：后者靠 checkpoint 找到任务，这里靠任务自带的
 * githubIssue 字段反查。两者互补，覆盖「checkpoint 已删但任务没归档」的情况。
 */
async function archiveOrphanTasks(root, exec, log, signal) {
  const backlog = join(root, "tasks", "backlog");
  let files;
  try { files = await readdir(backlog); } catch { return []; }
  const candidates = [];
  for (const name of files) {
    if (!/^TASK-\d+\.md$/.test(name)) continue;
    try {
      const text = await readFile(join(backlog, name), "utf8");
      const m = text.match(/^githubIssue:\s*(\d+)$/m);
      if (m) candidates.push({ taskId: name.slice(0, -3), issue: Number(m[1]) });
    } catch { /* 跳过不可读文件 */ }
  }
  if (!candidates.length) return [];
  // 一次拉全量，避免逐个 issue / PR 查询。
  const issues = JSON.parse((await exec("gh",
    ["issue", "list", "--state", "all", "--limit", "1000", "--json", "number,state"])).stdout ?? "[]");
  const closed = new Set(issues.filter(i => i.state === "CLOSED").map(i => i.number));
  const merged = new Set();
  const prs = JSON.parse((await exec("gh",
    ["pr", "list", "--state", "merged", "--limit", "1000", "--json", "body"])).stdout ?? "[]");
  for (const pr of prs) for (const n of closingReferences(pr.body)) merged.add(n);
  const done = [];
  for (const c of selectOrphanTasks(candidates, closed, merged)) {
    if (signal?.aborted) break;
    await exec("git", ["mv", `tasks/backlog/${c.taskId}.md`, `tasks/done/${c.taskId}.md`], { cwd: root });
    done.push(c.taskId);
  }
  if (done.length) {
    await exec("git", ["commit", "-m", orphanArchiveCommitSubject(done.length)], { cwd: root });
    log(`Archived ${done.length} orphan task(s): ${done.join(", ")}`);
  }
  return done;
}
