import { dataRoot } from "./config.mjs";
import { open, readFile, readdir, rm, lstat, realpath, mkdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { run } from "./process.mjs";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.mjs";
const samePath = (a,b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

// Cleanup is restricted to Runner-owned GitHub tasks with an exact merged PR head.
export async function cleanupMergedTasks(root, { execute=run, log=console.log, signal, base = "main" }={}) {
  const checkpointDir=join(dataRoot(root),"checkpoints"), lockDir=join(root,".soxu","locks");
  let files;try { files=await readdir(checkpointDir); } catch(e) {if(e.code==="ENOENT")return [];throw e;}
  const ids=[...new Set(files.map(x=>/^(?:github-)?issue-(\d+)\.json$/.exec(x)?.[1]).filter(Boolean))];
  const results=[];let repository;
  for(const id of ids) {
    if(signal?.aborted) break;
    const state=await readCheckpoint(Number(id),checkpointDir,false);
    if(!state || state.local || state.status!=="done" || state.phase!=="done" || state.cleanup?.complete) continue;
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
      const pr=JSON.parse((await exec("gh",["pr","view",state.pr,"--json","state,mergedAt,baseRefName,headRefName,headRefOid,isCrossRepository"])).stdout);
      if(pr.state!=="MERGED" || !pr.mergedAt || pr.baseRefName!==base || pr.headRefName!==branch || pr.headRefOid!==sha || pr.isCrossRepository!==false) {results.push({issue:n,status:"not-verified"});continue;}
      const remote=(await exec("git",["ls-remote","--heads","origin",`refs/heads/${branch}`])).stdout.trim();
      let remoteStatus="absent";
      if(remote){if(remote!==`${sha}\trefs/heads/${branch}`) remoteStatus="changed";
        else {await exec("git",["push",`--force-with-lease=refs/heads/${branch}:${sha}`,"origin",`:refs/heads/${branch}`]);remoteStatus="deleted";}}
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
        if(refHash.stdout.trim()!==sha) localStatus="changed";
        else if(holders.length>1 || holders.some(x=>x.locked) || (holders.length && !samePath(await realpath(holders[0].path),await realpath(expected)))) localStatus="other-worktree";
        else {
          if(holders.length){
            const st=await lstat(expected), parent=await lstat(managed);
            const realParent=await realpath(managed), realExpected=await realpath(expected);
            const actualRel=relative(realParent,realExpected), expectedRel=relative(managed,expected);
            const same=process.platform==="win32" ? actualRel.toLowerCase()===expectedRel.toLowerCase() : actualRel===expectedRel;
            if(!st.isDirectory() || st.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink() || !same) throw Error("unsafe-worktree-path");
            const statusRaw=(await exec("git",["status","--porcelain=v1","-z","--untracked-files=normal","--ignored=matching"],{cwd:expected})).stdout;
            if(statusRaw.length>=990000) throw Error("worktree-status-too-large");
            const status=statusRaw.split("\0").filter(Boolean);
            const unsafe=status.some(x=>!/^!! (?:[^/]+\/)*(?:node_modules|target|dist)\/$/.test(x));
            if(unsafe) localStatus="dirty";
            else {await exec("git",["worktree","remove",expected]);localStatus="removed";}
          }
          if(!holders.length || localStatus==="removed") {await exec("git",["update-ref","-d",`refs/heads/${branch}`,sha]);localStatus="deleted";}
        }
      } else if(ref.code!==1) throw Error("local-ref-unavailable");
      const complete=["absent","deleted"].includes(remoteStatus) && ["absent","deleted"].includes(localStatus);
      fresh.cleanup={complete,remote:remoteStatus,local:localStatus,checkedAt:new Date().toISOString()};await writeCheckpoint(fresh,checkpointDir);
      const result={issue:n,status:complete?"cleaned":"preserved",remote:remoteStatus,local:localStatus};results.push(result);
      // main is the default branch, so "Closes #N" never fires for dev merges. Close the
      // issue here (idempotent) so the issue list and downstream dependencies agree.
      if(complete){try{const seen=JSON.parse((await exec("gh",["issue","view",String(n),"--json","state"])).stdout);if(seen.state==="OPEN"){await exec("gh",["issue","close",String(n),"--comment",`已合入集成分支 ${base}；release 发布到 main 后随版本生效。`]);result.issueClosed="closed";}else result.issueClosed="already-closed";}catch{result.issueClosed="unknown";}}
      log(`Merged cleanup #${n}: remote=${remoteStatus}, local=${localStatus}`);
    } catch(e) {results.push({issue:n,status:"error"});log(`Merged cleanup #${n} could not be completed; the next run will retry.`);}
    finally {await rm(lock,{force:true});}
  }
  return results;
}
