import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseTaskDocument, loadTaskCatalog, validateTaskCatalog, planTaskQueue, taskIdFromIssueTitle} from '../src/task-catalog.mjs';
import {planGithubQueue, mergedIssueNumbers, waitingLabelDowngrades} from '../src/github-queue.mjs';
import {localTasks} from '../src/local-queue.mjs';
import {writeCheckpoint} from '../src/checkpoint.mjs';
import {git} from '../src/process.mjs';

const markdown = (id, priority = 'P0', dependencies = []) => `---\nid: ${id}\npriority: ${priority}\ndependencies: [${dependencies.join(', ')}]\n---\n\n# Title ${id}\n`;
const doc = (id,priority,deps) => parseTaskDocument(`${id}.md`,markdown(id,priority,deps));

test('merged detection follows the configured integration branch', () => {
  const prs = [
    { number: 1, baseRefName: "dev", mergedAt: "2026-10-28T00:00:00Z", body: "Closes #11" },
    { number: 2, baseRefName: "main", mergedAt: "2026-10-28T00:00:00Z", body: "Closes #12" },
  ];
  assert.deepEqual([...mergedIssueNumbers(prs, "dev")], [11]);
  assert.deepEqual([...mergedIssueNumbers(prs, "main")], [12]);
  assert.deepEqual([...mergedIssueNumbers(prs)], [12], "default stays main for compatibility");
});

test('an absent backlog or done directory is an empty catalog, not an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soxu-catalog-'));
  try {
    // Neither directory exists yet.
    assert.deepEqual(await loadTaskCatalog(root), []);
    await mkdir(join(root, 'tasks', 'done'), { recursive: true });
    await writeFile(join(root, 'tasks', 'done', 'TASK-001.md'), markdown('TASK-001'));
    const doneOnly = await loadTaskCatalog(root);
    assert.deepEqual(doneOnly.map(t => t.id), ['TASK-001']);
    assert.equal(doneOnly[0].archived, true);
    // Backlog present, done absent.
    const other = await mkdtemp(join(tmpdir(), 'soxu-catalog-b-'));
    await mkdir(join(other, 'tasks', 'backlog'), { recursive: true });
    await writeFile(join(other, 'tasks', 'backlog', 'TASK-002.md'), markdown('TASK-002'));
    const backlogOnly = await loadTaskCatalog(other);
    assert.deepEqual(backlogOnly.map(t => t.id), ['TASK-002']);
    assert.equal(backlogOnly[0].archived, false);
    await rm(other, { recursive: true, force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real catalog keeps every finished task archived and schedules nothing', async () => {
  const catalog = await loadTaskCatalog();
  validateTaskCatalog(catalog); // archived tasks still satisfy dependencies
  const plan = planTaskQueue(catalog, new Set());
  // TASK-001..006 are merged/archived; the newest backlog entries are schedulable.
  assert.deepEqual(plan.ready.map(t => t.id), ['TASK-007', 'TASK-008']);
  assert.deepEqual(plan.waiting.map(t => t.id), []);
  assert.deepEqual([...catalog].map(t => t.id).sort(),
    ['TASK-001','TASK-002','TASK-003','TASK-004','TASK-005','TASK-006','TASK-007','TASK-008']);
  assert.ok(catalog.filter(t => !['TASK-007','TASK-008'].includes(t.id)).every(t => t.archived),
    'finished tasks stay archived');
});

test('frontmatter rejects duplicate dependencies, unknown refs, cycles and inconsistent ids', () => {
  assert.throws(()=>doc('TASK-001','P0',['TASK-002','TASK-002']),/duplicate dependencies/);
  assert.throws(()=>parseTaskDocument('TASK-009.md',markdown('TASK-008')),/differs/);
  assert.throws(()=>validateTaskCatalog([doc('TASK-001','P0',['TASK-999'])]),/Unknown dependency/);
  assert.throws(()=>validateTaskCatalog([doc('TASK-001','P0',['TASK-002']),doc('TASK-002','P0',['TASK-001'])]),/cycle/);
  assert.throws(()=>parseTaskDocument('TASK-001.md',markdown('TASK-001').replace('priority: P0','priority: P9')),/Invalid priority/);
});

const issue = (number,id,state='OPEN',label='agent:ready') => ({number,title:`[${id}] Title`,state,labels:[{name:label}]});
test('milestone-prefixed task titles retain dependency scheduling and legacy compatibility',()=>{
  const catalog=[doc('TASK-001','P0',[]),doc('TASK-002','P1',['TASK-001'])];
  const items=[{...issue(87,'TASK-001'),title:'[M1] [TASK-001] 实现基础功能'}, {...issue(42,'TASK-002'),title:'[M1] [TASK-002] 后续功能'}];
  assert.equal(taskIdFromIssueTitle(items[0].title),'TASK-001');
  assert.equal(taskIdFromIssueTitle('[TASK-001] Legacy'),'TASK-001');
  assert.deepEqual(planGithubQueue(items,catalog).map(x=>x.number),[87]);
  items[0].state='CLOSED';
  assert.deepEqual(planGithubQueue(items,catalog,new Set([87])).map(x=>x.number),[42]);
});
test('GitHub dependency checks use TASK ids, not different Issue numbers', () => {
  const catalog=[doc('TASK-001','P0',[]),doc('TASK-002','P1',['TASK-001']),doc('TASK-003','P2',['TASK-002'])];
  const first=[issue(87,'TASK-001'),issue(42,'TASK-002'),issue(5,'TASK-003')];
  assert.deepEqual(planGithubQueue(first,catalog).map(i=>i.number),[87]);
  first[0].state='CLOSED';
  const merged=new Set([87]);
  assert.deepEqual(planGithubQueue(first,catalog,merged).map(i=>i.number),[42]);
  first[1].state='CLOSED';
  merged.add(42);
  first[2].labels=[{name:'agent:waiting'}];
  const [last]=planGithubQueue(first,catalog,merged);
  assert.equal(last.number,5);
  assert.equal(last.promote,true);
});

test('blocked and paused issues never become eligible; PR created is not dependency completion', () => {
  const catalog=[doc('TASK-001','P0',[]),doc('TASK-002','P0',['TASK-001'])];
  const issues=[issue(10,'TASK-001','OPEN','agent:pr'),issue(20,'TASK-002','OPEN','agent:ready')];
  assert.deepEqual(planGithubQueue(issues,catalog),[]);
  issues[0].state='CLOSED';
  issues[1].labels=[{name:'agent:blocked'}];
  assert.deepEqual(planGithubQueue(issues,catalog),[]);
  issues[1].labels=[{name:'agent:waiting'}];
  assert.deepEqual(planGithubQueue(issues,catalog).map(i=>i.number),[]); // closed alone is not a merged PR
  assert.deepEqual(planGithubQueue(issues,catalog,new Set([10])).map(i=>i.number),[20]);
});

test('local dependency needs predecessor commit integrated into main, not merely checkpoint done', async () => {
  const root=await mkdtemp(join(tmpdir(),'soxu-local-deps-'));
  try {
    await git(['init','-q','-b','main'],root);
    await git(['config','user.email','soxu@example.invalid'],root);
    await git(['config','user.name','SOXU'],root);
    await writeFile(join(root,'readme.md'),'base\n');
    await mkdir(join(root,'tasks','backlog'),{recursive:true});
    await writeFile(join(root,'tasks/backlog/TASK-001.md'),markdown('TASK-001'));
    await writeFile(join(root,'tasks/backlog/TASK-002.md'),markdown('TASK-002','P0',['TASK-001']));
    await git(['add','.'],root);
    await git(['commit','-qm','base'],root);
    assert.deepEqual((await localTasks(root)).ready.map(t=>t.id),['TASK-001']);
    await git(['checkout','-qb','agent/local-issue-1-test'],root);
    await writeFile(join(root,'implementation.md'),'implemented\n');
    await git(['add','.'],root);
    await git(['commit','-qm','implemented'],root);
    const commit=await git(['rev-parse','HEAD'],root);
    await git(['checkout','main'],root);
    await writeCheckpoint({issue:{number:1},local:true,status:'done',phase:'done',commit},join(root,'.soxu','checkpoints'));
    assert.deepEqual((await localTasks(root)).ready.map(t=>t.id),[]);
    await git(['merge','--ff-only','agent/local-issue-1-test'],root);
    assert.deepEqual((await localTasks(root)).ready.map(t=>t.id),['TASK-002']);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('merged PR evidence requires exact closing reference, main branch, and merged timestamp',()=> {
  const prs=[
    {baseRefName:'main',mergedAt:'2026-10-25T01:01:00Z',body:'Autonomous change\n\nCloses #87\n'},
    {baseRefName:'feature',mergedAt:'2026-10-25T01:01:00Z',body:'Closes #42'},
    {baseRefName:'main',mergedAt:null,body:'Closes #123'},
    {baseRefName:'main',mergedAt:'2026-10-25T01:02:00Z',body:'Closes #87a'},
  ];
  assert.deepEqual([...mergedIssueNumbers(prs)],[87]);
});

test('legacy incorrectly ready dependent is downgraded without touching human blocked tasks',()=>{
  const catalog=[doc('TASK-001','P0',[]),doc('TASK-002','P1',['TASK-001'])];
  const issues=[issue(10,'TASK-001'),issue(20,'TASK-002'),issue(30,'TASK-002','OPEN','agent:blocked')];
  // Duplicate tagged issues are a hard stop, so test the blocked case without another duplicate.
  issues[2].title='[TASK-999] unrelated blocked';
  const ready=planGithubQueue(issues,catalog);
  assert.deepEqual(ready.map(x=>x.number),[10]);
  assert.deepEqual(waitingLabelDowngrades(issues,catalog,ready).map(x=>x.number),[20]);
});
