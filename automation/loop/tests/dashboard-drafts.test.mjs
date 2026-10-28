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
