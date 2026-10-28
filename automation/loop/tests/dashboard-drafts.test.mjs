import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DraftStore,validateAnswers} from '../src/dashboard-drafts.mjs';
const a={title:'功能',feasibility:'可行',plan:'实施',dependencies:'无',acceptance:'验收',unknowns:'部署平台',questions:[{text:'部署平台',options:['Windows','Linux']}]};
const tick=()=>new Promise(r=>setTimeout(r,10));
async function waitForIdle(store){const deadline=Date.now()+5000;while(store.busy && Date.now()<deadline) await tick();assert.equal(store.busy,false,'operation did not finish');}
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'soxu-drafts-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
test('drafts persist in chosen order and editing invalidates assessment',()=>fixture(async root=>{const s=new DraftStore({root,assess:async()=>a});await s.initialized;let state=await s.save({requirement:'这是一个足够长的需求描述一'});const first=state.items[0].id;state=await s.save({requirement:'这是一个足够长的需求描述二'});const second=state.items[1].id;await s.move(second,-1);const reload=new DraftStore({root});await reload.initialized;assert.deepEqual(reload.state().items.map(x=>x.id),[second,first]);await s.evaluate(first);await waitForIdle(s);assert.equal(s.state().items[1].status,'review');await s.save({id:first,requirement:'这是修改之后的需求描述一'});assert.equal(s.state().items[1].assessment,undefined);}));
test('all unknowns require valid multi-select or custom answers',()=>{assert.throws(()=>validateAnswers(a,[]));assert.throws(()=>validateAnswers(a,[{selected:['Other'],custom:''}]));assert.throws(()=>validateAnswers(a,[{selected:[],custom:'  '}]));assert.deepEqual(validateAnswers(a,[{selected:['Linux','Windows'],custom:'其他'}]),[{selected:['Linux','Windows'],custom:'其他'}]);});
test('batch submits in queue order, stops on unknown and survives restart',()=>fixture(async root=>{const calls=[];const s=new DraftStore({root,assess:async()=>a,submit:async(_,d)=>{calls.push(d.id);if(calls.length===2)throw Error('timeout');return 'https://github.com/a/b/issues/1';}});await s.initialized;const ids=[];for(let i=0;i<3;i++){const x=await s.save({requirement:`这是第 ${i} 项需求的详细说明`});ids.push(x.items.at(-1).id);await s.evaluate(ids[i]);await waitForIdle(s);await s.answer(ids[i],[{selected:['Linux'],custom:''}],false,null);}await s.batch([...ids].reverse());await waitForIdle(s);assert.deepEqual(calls,ids.slice(0,2));assert.deepEqual(s.state().items.map(x=>x.status),['submitted','unknown','review']);const reloaded=new DraftStore({root});await reloaded.initialized;assert.equal(reloaded.state().items[1].status,'unknown');await assert.rejects(()=>reloaded.batch([ids[2]]),/submit-unresolved/);await reloaded.resolve(ids[1],false,null);assert.equal(reloaded.state().items[1].status,'review');}));
test('reassess re-runs the assessment with confirmed answers and drops stale answers', () => fixture(async root => {
  const seen = [];
  const s = new DraftStore({ root, assess: async (r, requirement, signal, index, onModel, extra) => {
    seen.push(extra ?? null);
    if (!extra) return a;
    return { ...a, feasibility: '可行（部署平台已确认）', feasibilityStatus: 'feasible', unknowns: '无', questions: [] };
  } });
  await s.initialized;
  const id = (await s.save({ requirement: '一个需要重新评估可行性的需求' })).items[0].id;
  await s.evaluate(id);
  await waitForIdle(s);
  await assert.rejects(() => s.reassess(id), /answers-required/);
  await s.answer(id, [{ selected: ['Linux'], custom: '' }], false, null);
  await s.reassess(id);
  await waitForIdle(s);
  const d = s.state().items[0];
  assert.equal(d.status, 'review');
  assert.equal(d.assessment.feasibilityStatus, 'feasible');
  assert.equal(d.reassessCount, 1);
  assert.equal(seen.at(-1).answers[0].selected[0], 'Linux');
  // The new assessment has no unknowns, so the old answer no longer applies.
  assert.equal(d.answers, undefined);
  assert.equal(d.answersReset, true);
}));

test('a failed reassess keeps the previous assessment available', () => fixture(async root => {
  let call = 0;
  const s = new DraftStore({ root, assess: async () => { call += 1; if (call > 1) throw new Error('network down'); return a; } });
  await s.initialized;
  const id = (await s.save({ requirement: '另一个需要重新评估的需求说明' })).items[0].id;
  await s.evaluate(id);
  await waitForIdle(s);
  const before = s.state().items[0].assessment;
  await s.answer(id, [{ selected: ['Windows'], custom: '' }], false, null);
  await s.reassess(id);
  await waitForIdle(s);
  const d = s.state().items[0];
  assert.equal(d.status, 'review');
  assert.deepEqual(d.assessment, before);
  assert.equal(d.answers[0].selected[0], 'Windows');
  assert.match(d.error, /评估失败/);
}));

test('crash during submit becomes unknown and legacy marker blocks batch',()=>fixture(async root=>{const s=new DraftStore({root,assess:async()=>a});await s.initialized;const id=(await s.save({requirement:'一个需要保存和确认的需求说明'})).items[0].id;await s.evaluate(id);await waitForIdle(s);await s.answer(id,[{selected:[],custom:'待 Windows 验证'}],false,'M1');await mkdir(join(root,'.soxu','intake'),{recursive:true});await writeFile(join(root,'.soxu','intake','pending-submit.json'),'{}');await assert.rejects(()=>s.batch([id]),/submit-unresolved/);await rm(join(root,'.soxu','intake','pending-submit.json'));s.items[0].status='submitting';await s.persist();const reload=new DraftStore({root});await reload.initialized;assert.equal(reload.state().items[0].status,'unknown');await assert.rejects(()=>reload.resolve(id,true,'https://example.com'),/invalid-url/);}));

test("drafts can be reordered by dropping before another draft", async () => {
  const { DraftStore } = await import("../src/dashboard-drafts.mjs");
  const root = await mkdtemp(join(tmpdir(), "soxu-reorder-"));
  try {
    const store = new DraftStore({ root, assess: async () => ({}), submit: async () => "" });
    await store.initialized;
    store.items = [
      { id: "11111111-1111-4111-8111-111111111111", requirement: "aaaaaaaaaa", status: "draft" },
      { id: "22222222-2222-4222-8222-222222222222", requirement: "bbbbbbbbbb", status: "draft" },
      { id: "33333333-3333-4333-8333-333333333333", requirement: "cccccccccc", status: "draft" },
    ];
    const [a, b, c] = store.items.map(x => x.id);
    let state = await store.reorder(c, a);
    assert.deepEqual(state.items.map(x => x.id), [c, a, b], "drop before first item");
    state = await store.reorder(c, null);
    assert.deepEqual(state.items.map(x => x.id), [a, b, c], "drop at the end");
    state = await store.reorder(c, b);
    assert.deepEqual(state.items.map(x => x.id), [a, c, b], "drop in the middle");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dependency verification marks drafts blocked with the missing task ids", async () => {
  const { verifyDependencies } = await import("../src/dashboard-drafts.mjs");
  const root = await mkdtemp(join(tmpdir(), "soxu-deps-"));
  try {
    await mkdir(join(root, "tasks", "done"), { recursive: true });
    await writeFile(join(root, "tasks", "done", "TASK-007.md"), "# done");
    const drafts = [
      { id: "a", assessment: { dependencies: "TASK-007" } },
      { id: "b", assessment: { dependencies: "TASK-007、TASK-099" } },
      { id: "c", assessment: { dependencies: "无" } },
    ];
    const result = await verifyDependencies(root, drafts);
    assert.equal(result.get("a").ok, true);
    assert.deepEqual(result.get("a").missing, []);
    assert.equal(result.get("b").ok, false);
    assert.deepEqual(result.get("b").missing, ["TASK-099"]);
    assert.equal(result.get("c").ok, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ready can be toggled directly from the queue", async () => {
  const { DraftStore } = await import("../src/dashboard-drafts.mjs");
  const root = await mkdtemp(join(tmpdir(), "soxu-ready-"));
  try {
    const store = new DraftStore({ root, assess: async () => ({}), submit: async () => "" });
    await store.initialized;
    const id = "11111111-1111-4111-8111-111111111111";
    store.items = [{ id, requirement: "aaaaaaaaaa", status: "review", assessment: { unknowns: "无" }, answers: [] }];
    let state = await store.setReady(id, true);
    assert.equal(state.items[0].ready, true);
    state = await store.setReady(id, false);
    assert.equal(state.items[0].ready, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a blocked draft can be resubmitted once its dependencies are archived", async () => {
  const { DraftStore } = await import("../src/dashboard-drafts.mjs");
  const root = await mkdtemp(join(tmpdir(), "soxu-blocked-"));
  try {
    await mkdir(join(root, "tasks", "done"), { recursive: true });
    const id = "11111111-1111-4111-8111-111111111111";
    let submitted = 0;
    const store = new DraftStore({ root, assess: async () => ({}), submit: async () => { submitted += 1; return "https://github.com/a/b/issues/1"; } });
    await store.initialized;
    store.items = [{ id, requirement: "aaaaaaaaaa", status: "blocked", ready: true,
      assessment: { title: "T", unknowns: "无", dependencies: "TASK-099" }, answers: [], error: "依赖未满足" }];

    await store.batch([id]);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(store.items[0].status, "blocked", "still blocked while TASK-099 is missing");
    assert.deepEqual(store.items[0].dependencyCheck.missing, ["TASK-099"]);
    assert.equal(submitted, 0, "nothing is submitted for review");

    await writeFile(join(root, "tasks", "done", "TASK-099.md"), "# done");
    await store.batch([id]);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(store.items[0].status, "submitted", "resubmits after the dependency lands");
    assert.equal(submitted, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

