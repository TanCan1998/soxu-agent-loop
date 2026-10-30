import { dataRoot } from "./config.mjs";
import { open, readFile, readdir, rm, lstat, realpath, mkdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { run } from "./process.mjs";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.mjs";
const samePath = (a,b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

// Cleanup is restricted to Runner-owned GitHub tasks with an exact merged PR head.
/** 合入集成分支后关闭 Issue（幂等；结果缓存在检查点里，避免每轮都问 GitHub）。 */
async function closeMergedIssue(exec, state, n, base) {
  if (state.issueClosed === "closed") return "cached";
  try {
    const seen = JSON.parse((await exec("gh", ["issue", "view", String(n), "--json", "state"])).stdout);
    if (seen.state !== "OPEN") { state.issueClosed = "already-closed"; return "already-closed"; }
    // 关闭前清掉「未完成」状态标签：已合入的任务不该继续挂着 in-progress/paused/blocked。
    const view = JSON.parse((await exec("gh", ["issue", "view", String(n), "--json", "labels"])).stdout);
    // agent:pr 也要清：已合入并关闭的 Issue 挂着它会让面板一直显示成"待合并"，
    // 历史上有 26 个 Issue 因此需要人工清理（2026-10-29）。
    const stale = (view.labels ?? []).map(x => x.name).filter(name => ["agent:in-progress", "agent:paused", "agent:blocked", "agent:ready", "agent:waiting", "agent:pr"].includes(name));
    if (stale.length) await exec("gh", ["issue", "edit", String(n), ...stale.flatMap(name => ["--remove-label", name])]);
    await exec("gh", ["issue", "close", String(n), "--comment", `已合入集成分支 ${base}；release 发布到 main 后随版本生效。`]);
    state.issueClosed = "closed";
    return "closed";
  } catch { return "unknown"; }
}
export async function cleanupMergedTasks(root, { execute=run, log=console.log, signal, base = "main" }={}) {
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
      if(await closeMergedIssue(execAtRoot, state, Number(id), base) === "closed") await writeCheckpoint(state, checkpointDir);
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
      if(complete) result.issueClosed=await closeMergedIssue(exec, fresh, n, base);
      results.push(result);
      log(`Merged cleanup #${n}: remote=${remoteStatus}, local=${localStatus}`);
    } catch(e) {results.push({issue:n,status:"error"});log(`Merged cleanup #${n} could not be completed; the next run will retry.`);}
    finally {await rm(lock,{force:true});}
  }
  return results;
}
