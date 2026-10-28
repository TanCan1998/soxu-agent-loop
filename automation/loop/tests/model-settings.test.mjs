import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readModelSettings,saveModelSettings,selectModel,parsePiModelList,getPiModels} from "../src/model-settings.mjs";
import {pinTaskModels} from "../src/worker.mjs";
import {loadRoleModels,modelArgs} from "../src/agent-models.mjs";
import {isModelIdentifier} from "../src/model-identifiers.mjs";
const a={provider:"magpie",model:"one"},b={provider:"magpie",model:"two"},c={provider:"other",model:"third"};
test("Pi table parsing accepts only explicit rows and does not return warning text",async()=>{
  const text="provider  model  context  max-out  thinking  images\nmagpie   auto/deepseek-v4.1-flash  200K  8K  yes  no\n";
  assert.deepEqual(parsePiModelList(text),[{provider:"magpie",model:"auto/deepseek-v4.1-flash"}]);
  assert.throws(()=>parsePiModelList("unrecognized output"));
  const result=await getPiModels("/repo",async()=>({stdout:text,stderr:"warning: test"}));
  assert.equal(result.warning,true);assert.equal(result.models.length,1);
});
test("settings persist explicit global, role override and pins; revisions prevent lost updates",async()=>{
  const root=await mkdtemp(join(tmpdir(),"soxu-models-"));
  try {
    await mkdir(join(root,"automation"));
    await writeFile(join(root,"automation","agent-models.json"),JSON.stringify({schemaVersion:1,roles:{developer:{provider:"target",model:"developer"},reviewer:{provider:"target",model:"reviewer"}}}));
    const baseline=await loadRoleModels({}, {root});
    assert.equal(baseline.developer.provider,"target");
    const initial=await readModelSettings(root);initial.global=[a,b];initial.roles.reviewer=[c];initial.favorites=[b];
    const saved=await saveModelSettings(initial,root);assert.equal(saved.revision,1);
    assert.deepEqual(await readModelSettings(root),saved);
    assert.deepEqual(selectModel(saved,"developer",0,null),{...a,thinking:null});
    assert.deepEqual(selectModel(saved,"developer",1,null),{...b,thinking:null});
    assert.deepEqual(selectModel(saved,"reviewer",1,null),{...c,thinking:null});
    await assert.rejects(()=>saveModelSettings(initial,root),e=>e.status===409);
    const assigned=await loadRoleModels({}, {root,index:1});assert.deepEqual(assigned.developer,{...b,thinking:null});assert.deepEqual(assigned.reviewer,{...c,thinking:null});
    const env=await loadRoleModels({SOXU_DEVELOPER_PROVIDER:"env",SOXU_DEVELOPER_MODEL:"model"},{root,index:1});assert.equal(env.developer.provider,"env");
    saved.roles.product=[];await assert.rejects(()=>saveModelSettings(saved,root));
  }finally{await rm(root,{recursive:true,force:true});}
});

test("resumed task reuses its saved selection even after settings change",async()=>{
  const state={}, calls=[];
  const first=await pinTaskModels(state,2,async index=>{calls.push(index);return {developer:{...b,thinking:null},reviewer:{...c,thinking:null}};},async()=>{});
  const again=await pinTaskModels(state,2,async()=>{throw Error("must not reselect");},async()=>{throw Error("must not rewrite");});
  assert.deepEqual(again,first);assert.deepEqual(calls,[1]);
  await assert.rejects(()=>pinTaskModels({modelAssignments:{developer:{...a}}},1,async()=>{},async()=>{}));
});


test("a manual stop lets the next start adopt the current model settings", async () => {
  const { releasePinnedModelsAfterManualStop } = await import("../src/worker.mjs");
  const pinned = { developer: { ...b, thinking: null }, reviewer: { ...c, thinking: null } };
  const manual = { reason: "interrupted", modelAssignments: { ...pinned } };
  assert.equal(releasePinnedModelsAfterManualStop(manual), true);
  assert.equal(manual.modelAssignments, undefined);
  // Failure pauses keep their models so retries and cost stay predictable.
  for (const reason of ["quota", "network", "timeout"]) {
    const failed = { reason, modelAssignments: { ...pinned } };
    assert.equal(releasePinnedModelsAfterManualStop(failed), false);
    assert.deepEqual(failed.modelAssignments, pinned);
  }
  assert.equal(releasePinnedModelsAfterManualStop({ reason: "interrupted" }), false);
  assert.equal(releasePinnedModelsAfterManualStop(null), false);
});

test("Unicode providers and Windows model paths remain selectable without shell injection", async()=>{
  const rows="provider model context max-out thinking images\nDoCode-🇨🇳22✖️ deepseek-v4-pro 1M 262K yes no\nDoCode×9 model 1M 2K yes no\nllama F:\\AI\\Models\\blobs\\sha256-123 1M 2K no no\n";
  const models=parsePiModelList(rows);
  assert.equal(models.length,3);
  for(const item of models) assert.deepEqual(modelArgs(item),["--provider",item.provider,"--model",item.model]);
  const root=await mkdtemp(join(tmpdir(),"soxu-unicode-model-"));
  try { const settings=await readModelSettings(root);settings.global=models;await saveModelSettings(settings,root);assert.deepEqual((await readModelSettings(root)).global,models); }
  finally {await rm(root,{recursive:true,force:true});}
  for(const unsafe of ["foo&echo", "foo|echo", "foo%PATH%", "foo!bar", "foo^bar", "foo bar", "-option", "foo\nbar", 'foo"bar', "foo;bar", "foo bar"]) assert.equal(isModelIdentifier(unsafe),false,unsafe);
});
