import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGithubStatus, enrichActiveChecks } from "../src/dashboard-github.mjs";
test("an open issue whose PR merged into the integration branch counts as merged", () => {
  const catalog = [{ id: "TASK-011", number: 11, title: "Eleven", dependencies: [], priority: "P1" }];
  const prs = [{ number: 90, state: "MERGED", mergedAt: "2026-10-28T00:00:00Z", baseRefName: "dev", body: "Closes #11", headRefName: "agent/x", url: "https://github.com/a/b/pull/90" }];
  const open = [{ number: 11, state: "OPEN", title: "[M2] [TASK-011] Eleven", labels: [], milestone: { title: "M2" } }];
  const snapshot = buildGithubStatus(catalog, open, prs, "dev");
  assert.equal(snapshot["TASK-011"].pr.number, 90, "per-task PR lookup must follow the integration branch");
  assert.equal(snapshot.__roadmap.stages.find(stage => stage.id === "M2").merged, 1, "merged into dev counts even while the issue is open");
  // Same PR is invisible when the integration branch is main.
  assert.equal(buildGithubStatus(catalog, open, prs, "main")["TASK-011"].pr, null);
});

test("PR checks and unresolved dependencies reflect GitHub evidence", () => {
  const catalog=[{id:"TASK-001",dependencies:[]},{id:"TASK-002",dependencies:["TASK-001"]}];
  const issues=[{number:11,title:"[TASK-001] One",state:"OPEN"},{number:22,title:"[TASK-002] Two",state:"OPEN"}];
  const prs=[{number:21,state:"OPEN",baseRefName:"main",body:"Closes #11",mergedAt:null,statusCheckRollup:[{status:"IN_PROGRESS",conclusion:""}]}];
  let snapshot=buildGithubStatus(catalog,issues,prs);
  assert.deepEqual(snapshot["TASK-001"].pr,{number:21,title:"",url:null,state:"open",ci:"pending"});
  assert.deepEqual(snapshot["TASK-002"].missing,["TASK-001"]);
  prs[0].statusCheckRollup=[{status:"COMPLETED",conclusion:"FAILURE"}];
  assert.equal(buildGithubStatus(catalog,issues,prs)["TASK-001"].pr.ci,"failure");
  prs[0].mergedAt="2026-10-27T00:00:00Z"; prs[0].state="MERGED"; issues[0].state="CLOSED";
  snapshot=buildGithubStatus(catalog,issues,prs);
  assert.equal(snapshot["TASK-001"].pr.state,"merged");
  assert.deepEqual(snapshot["TASK-002"].missing,[]);
});

test("roadmap counts all classified issues rather than a fixed backlog",()=>{
  const catalog=[{id:"TASK-001",milestone:"M1",dependencies:[]}];
  const issues=[{number:1,title:"[TASK-001] First",state:"CLOSED",labels:[]},
    {number:90,title:"[M1] Additional work",state:"OPEN",labels:[{name:"agent:in-progress"}]},
    {number:91,title:"New work",state:"OPEN",milestone:{title:"M2 · 多 Agent"},labels:[{name:"agent:blocked"}]},
    {number:92,title:"[M2] Another",state:"OPEN",labels:[{name:"agent:waiting"}]},
    {number:93,title:"Other",state:"OPEN",labels:[{name:"agent:ready"}]}];
  const prs=[{number:21,state:"MERGED",baseRefName:"main",body:"Closes #1",mergedAt:"2026-10-27T00:00:00Z"}];
  const roadmap=buildGithubStatus(catalog,issues,prs).__roadmap;
  assert.deepEqual(roadmap.stages[1].issues,[1,90]);
  assert.equal(roadmap.stages[1].items[0].merged,true);
  assert.equal(roadmap.stages[1].items[1].title,"[M1] Additional work");
  assert.equal(roadmap.stages[2].total,2);assert.equal(roadmap.stages[2].paused,1);assert.equal(roadmap.unclassified,1);
});

test("active CI jobs expose bounded names and validated start times", () => {
  const c=[{id:"TASK-001", dependencies:[]}], i=[{number:11,title:"[TASK-001] One",state:"OPEN"}];
  const p=[{number:21,state:"OPEN",baseRefName:"main",body:"Closes #11",statusCheckRollup:[{name:"Rust / Tauri",status:"IN_PROGRESS",startedAt:"2026-10-27T10:00:00Z"}]}];
  assert.deepEqual(buildGithubStatus(c,i,p)["TASK-001"].pr.activeChecks,[{name:"Rust / Tauri",jobId:null,startedAt:"2026-10-27T10:00:00Z"}]);
  p[0].statusCheckRollup[0].startedAt="bad"; assert.equal(buildGithubStatus(c,i,p)["TASK-001"].pr.activeChecks[0].startedAt,null);
});

test("running step status is bounded and unavailable jobs do not fail the snapshot", async () => {
 const a={name:"CI",jobId:123}, b={name:"other",jobId:456};
 const snapshot={one:{pr:{activeChecks:[a,b]}}};
 await enrichActiveChecks(snapshot,"/repo",async (_bin,args)=>{
   if (args[1].endsWith("/456")) throw new Error("no permission");
   return {stdout:JSON.stringify({id:123,steps:[{name:"Install",status:"in_progress",started_at:"2026-10-27T10:00:00Z"}]})};
 });
 assert.equal(a.step.name,"Install"); assert.equal(a.stepObservedAt,"2026-10-27T10:00:00Z");
 assert.equal(b.stepStatus,"unavailable");
});

test("queue includes existing catalog tasks, unlabeled issues and closed issues",()=>{
 const catalog=[{id:"TASK-001",milestone:"M1",dependencies:[]}];
 const issues=[{number:1,title:"[M1] [TASK-001] 实现管理",state:"OPEN",labels:[]},
  {number:2,title:"[未归类] [ISSUE-2] 现有需求",state:"OPEN",labels:[]},
  {number:3,title:"[M0] [ISSUE-3] 已关闭",state:"CLOSED",labels:[]}];
 const data=buildGithubStatus(catalog,issues,[]);
 assert.equal(data["TASK-001"].issue,1);
 assert.deepEqual(data.__queue.map(x=>x.number),[1,2,3]);
 assert.equal(data.__queue[2].state,"CLOSED");
});
