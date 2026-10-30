import { test } from "node:test";
import assert from "node:assert/strict";
import { IntakeManager, parseIntake, submitRequirement } from "../src/dashboard-intake.mjs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
const assessment={title:"新需求",feasibility:"可行",plan:"分步实现",dependencies:"人工核对",acceptance:"测试",unknowns:"待确认"};
const tick=()=>new Promise(r=>setImmediate(r));
test("submitted issue carries a machine-readable dependency line", async () => {
  const root = await mkdtemp(join(tmpdir(), "soxu-intake-deps-"));
  try {
    const bodies = [];
    const execute = async (bin, args) => {
      const file = args[args.indexOf("--body-file") + 1];
      bodies.push(await readFile(file, "utf8"));
      return { stdout: "https://github.com/a/b/issues/42\n" };
    };
    const draft = {
      id: "66666666-6666-4666-8666-666666666666",
      requirement: "需要增加一个新功能",
      ready: false,
      milestone: "M2",
      assessment: { ...assessment, dependencies: "依赖项：TASK-002 先合并；依赖项：TASK-001 也要先完成" },
      answers: [{ selected: ["Windows"], custom: "" }],
      confirmationQuestions: [{ text: "部署平台", options: ["Windows"] }],
    };
    const url = await submitRequirement(root, draft, execute);
    assert.equal(url, "https://github.com/a/b/issues/42");
    const body = bodies[0];
    assert.match(body, /## 前置依赖（机器可读）/);
    assert.match(body, /dependencies: \[TASK-001, TASK-002\]/);
    assert.ok(body.indexOf("## 前置依赖（机器可读）") > body.indexOf("### 未知与待确认"), "dependency block must follow the assessment");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dependency ids are extracted from prose and de-duplicated", async () => {
  const { dependencyIds } = await import("../src/dashboard-intake.mjs");
  assert.deepEqual(dependencyIds("依赖项：TASK-002 先合并；TASK-001 也要；再提一次 TASK-002"), ["TASK-001", "TASK-002"]);
  assert.deepEqual(dependencyIds("无"), []);
  assert.deepEqual(dependencyIds(null), []);
});
test("assessment requires explicit confirmation and queues only selected state",async()=>{
  const root=await mkdtemp(join(tmpdir(),"soxu-intake-test-"));
  const calls=[]; const mgr=new IntakeManager({root,assess:async()=>assessment,submit:async(root,d)=>{calls.push(d.ready);return "https://github.com/a/b/issues/99";}});
  const draft=await mgr.start("需要增加一个新功能供项目使用");assert.equal(draft.status,"assessing");assert.equal(calls.length,0);
  await tick();assert.equal(mgr.publicState().status,"review");
  await assert.rejects(()=>mgr.confirm("invalid",true));assert.equal(calls.length,0);
  const result=await mgr.confirm(draft.id,false);assert.equal(result.status,"submitted");assert.deepEqual(calls,[false]);
  await assert.rejects(()=>mgr.confirm(draft.id,false));
  await rm(root,{recursive:true,force:true});
});
test("unknown submit outcome blocks repeated submission or reassessment",async()=>{
  const root=await mkdtemp(join(tmpdir(),"soxu-intake-test-"));
  const mgr=new IntakeManager({root,assess:async()=>assessment,submit:async()=>{throw Error("timeout");}});
  const d=await mgr.start("需要增加一个新功能供项目使用");await tick();
  assert.equal((await mgr.confirm(d.id,true)).status,"unknown");
  await assert.rejects(()=>mgr.start("需要增加一个新功能供项目使用"));
  await assert.rejects(()=>mgr.confirm(d.id,true));
  const reloaded=new IntakeManager({root,assess:async()=>assessment});await reloaded.initialized;
  assert.equal(reloaded.publicState().status,"unknown");
  await reloaded.clearUnknown(d.id);
  await rm(root,{recursive:true,force:true});
});
test("submission sends exact approved body and conservative queue choice",async()=>{
  const calls=[];const execute=async(bin,args)=>{calls.push({bin,args,body:await readFile(args[args.indexOf("--body-file")+1],"utf8")});return {stdout:"https://github.com/a/b/issues/99\n"};};
  // 里程碑必填（2026-10-30）：过去默认「未归类」会让 dashboard 无法归类。
  // submitRequirement 会写 tasks/backlog，必须给可写目录（Linux 上 /repo 不可写）
  const tmp=await mkdtemp(join(tmpdir(),"soxu-submit-"));
  try {
    await assert.rejects(()=>submitRequirement(tmp,{id:"test",requirement:"真实需求",assessment,ready:false},execute),/milestone-required/);
    await submitRequirement(tmp,{id:"test",requirement:"真实需求",assessment,ready:false,milestone:"M1"},execute);
  } finally { await rm(tmp,{recursive:true,force:true}); }
  assert.equal(calls[0].args.at(-1),"agent:blocked");assert.match(calls[0].body,/真实需求/);
});
test("model response is strictly structured and cannot impersonate backlog IDs",()=>{
  assert.deepEqual(parseIntake("SOXU_INTAKE_RESULT:"+JSON.stringify(assessment)),assessment);
  assert.throws(()=>parseIntake("SOXU_INTAKE_RESULT:"+JSON.stringify({...assessment,title:"[TASK-001] fake"})));
});

test("confirmed requirement is classified in the chosen milestone title",async()=>{
  let args;
  const execute=async(bin,argv)=>{args=argv;return {stdout:"https://github.com/a/b/issues/99\n"};};
  const tmp2=await mkdtemp(join(tmpdir(),"soxu-submit-"));
  try {
    await submitRequirement(tmp2,{id:"test",requirement:"需求",assessment,ready:true,milestone:"M2"},execute);
  } finally { await rm(tmp2,{recursive:true,force:true}); }
  // 编号由 catalog 现有最大值 +1 决定，不硬编码
assert.match(args[args.indexOf("--title")+1],/^\[M2\] \[TASK-\d{3}\] 新需求$/);
});


test("assessment failures provide safe, specific diagnostics without leaking underlying data",async()=>{
  const root=await mkdtemp(join(tmpdir(),"soxu-intake-errors-"));
  const cases=[[new Error("invalid-assessment"),"格式"],[new Error("TLS handshake timeout token=secret"),"网络"],[new Error("HTTP 429"),"额度"],[new Error("HTTP 401"),"认证"],[Object.assign(new Error("private output"),{kind:"timeout"}),"超时"],[new Error("secret raw prompt"),"无法确定"]];
  try {for(const [failure,expected] of cases){
    const mgr=new IntakeManager({root,assess:async()=>{throw failure;}});
    await mgr.start("需要增加一个新功能供项目使用");await tick();
    const state=mgr.publicState();assert.equal(state.status,"failed");assert.match(state.error,new RegExp(expected));
    assert.doesNotMatch(state.error,/secret|private|raw prompt|token/i);
  }} finally {await rm(root,{recursive:true,force:true});}
});


test("assessment accepts bounded formatted JSON and section lists without weakening validation",()=>{
  const value={...assessment,plan:["第一步","第二步"],acceptance:["可验证"]};
  assert.equal(parseIntake("说明\nSOXU_INTAKE_RESULT:\n```json\n"+JSON.stringify(value,null,2)+"\n``` ").plan,"- 第一步\n- 第二步");
  assert.deepEqual(parseIntake("SOXU_INTAKE_RESULT:"+JSON.stringify({...assessment,plan:'包含 } 和 \" 字符'})).title,assessment.title);
  for(const invalid of ["SOXU_INTAKE_RESULT:{", "SOXU_INTAKE_RESULT:"+JSON.stringify({...assessment,acceptance:[{}]}),"SOXU_INTAKE_RESULT:"+JSON.stringify({...assessment,title:"[TASK-004] fake"})]) assert.throws(()=>parseIntake(invalid));
});

test("accepts a single complete bare or fenced JSON but rejects ambiguous responses",()=>{
 const json=JSON.stringify(assessment);
 assert.deepEqual(parseIntake(json),assessment);
 assert.deepEqual(parseIntake("```json\n"+json+"\n```"),assessment);
 for(const value of ["解释\n"+json, json+"\n"+json, JSON.stringify({...assessment,title:"[M2] wrong"}), JSON.stringify({...assessment,plan:""})]) assert.throws(()=>parseIntake(value));
});
test("format error identifies category without exposing model text",async()=>{
 const root=await mkdtemp(join(tmpdir(),"soxu-intake-format-"));
 try { const mgr=new IntakeManager({root,assess:async()=>parseIntake('{"private":"secret"}')});
 await mgr.start("需要增加一个新功能供项目使用");await tick();
 assert.match(mgr.publicState().error,/字段缺失/);assert.doesNotMatch(mgr.publicState().error,/secret|private/);
 } finally {await rm(root,{recursive:true,force:true});}
});

test("literal DSML tool calls receive a safe, specific failure and are never executed", async()=>{
  const text='<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="fetch_content">file:///private/path</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
  assert.throws(()=>parseIntake(text), err=>err.reason === "tool-call");
  const root=await mkdtemp(join(tmpdir(),"soxu-intake-tool-"));
  try {
    const mgr=new IntakeManager({root,assess:async()=>parseIntake(text)});
    await mgr.start("需要增加一个新功能供项目使用");await tick();
    assert.match(mgr.publicState().error,/工具调用文本/);
    assert.doesNotMatch(mgr.publicState().error,/private|fetch_content/);
  } finally {await rm(root,{recursive:true,force:true});}
});
