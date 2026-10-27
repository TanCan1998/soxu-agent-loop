import {test} from "node:test";
import assert from "node:assert/strict";
import {mergeTaskPr} from "../src/dashboard-merge.mjs";

const base = {number:21,state:"OPEN",isDraft:false,isCrossRepository:false,baseRefName:"main",headRefName:"agent/github-issue-1-example",headRefOid:"a".repeat(40),body:"Closes #1",mergeable:"MERGEABLE",reviewDecision:"",statusCheckRollup:[{status:"COMPLETED",conclusion:"SUCCESS"}]};
test("merge pins PR head and deletes only exact remote ref",async()=>{
  const calls=[];
  const execute=async(bin,args)=>{calls.push([bin,args]);return {stdout:JSON.stringify(base)};};
  assert.deepEqual(await mergeTaskPr("/repo",1,21,execute),{merged:true,branchDeleted:true});
  assert.deepEqual(calls[1][1],["pr","merge","21","--squash","--match-head-commit",base.headRefOid]);
  assert.match(calls[2][1][1],/^--force-with-lease=refs\/heads\/agent\//);
  assert.equal(calls[2][1][3],":refs/heads/agent/github-issue-1-example");
});
test("failed checks, wrong issue or head, and merge failure never delete branch",async()=>{
  for(const change of [{statusCheckRollup:[{status:"IN_PROGRESS"}]},{body:"Closes #2"},{headRefName:"main"},{reviewDecision:"CHANGES_REQUESTED"}]){
    const calls=[];const exec=async(b,a)=>{calls.push(a);return {stdout:JSON.stringify({...base,...change})};};
    await assert.rejects(()=>mergeTaskPr("/repo",1,21,exec));assert.equal(calls.length,1);
  }
  const calls=[];const exec=async(b,a)=>{calls.push(a);if(a[1]==="merge")throw new Error("merge failed");return {stdout:JSON.stringify(base)};};
  await assert.rejects(()=>mergeTaskPr("/repo",1,21,exec));assert.equal(calls.length,2);
});
test("successful merge reports deletion failure separately",async()=>{
  const exec=async(b,a)=>{if(b==="git")throw new Error("lease rejected");return {stdout:JSON.stringify(base)};};
  assert.deepEqual(await mergeTaskPr("/repo",1,21,exec),{merged:true,branchDeleted:false,branch:base.headRefName});
});
