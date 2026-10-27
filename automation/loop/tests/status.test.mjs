import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, TOOL_ROOT } from '../src/config.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localProgress } from '../src/status.mjs';

const execFileAsync = promisify(execFile);

test('local progress separates done, running, paused and unstarted tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soxu-status-'));
  try {
    await mkdir(join(dir, 'tasks/backlog'), {recursive:true});
    await mkdir(join(dir, 'tasks/done'), {recursive:true});
    for (const id of [1,2,3]) await writeFile(join(dir,`tasks/backlog/TASK-${String(id).padStart(3,'0')}.md`),`# Task ${id}`);
    await writeFile(join(dir,'tasks/done/TASK-004.md'),'# done');
    const states = {2:{status:'running',phase:'code'},3:{status:'paused',phase:'review'}};
    const status = await localProgress(dir, async id => states[id] ?? null);
    assert.equal(status.total,4);
    assert.deepEqual([status.pending.length,status.running.length,status.paused.length,status.done.length],[1,1,1,1]);
    assert.equal(status.isLive,false);
    assert.equal(status.pending[0].title,'Task 1');
    assert.equal(status.running[0].title,'Task 2');
    assert.equal(status.paused[0].title,'Task 3');
    assert.equal(status.done[0].title,'done');
  } finally { await rm(dir,{recursive:true,force:true}); }
});


test('status names the checkpoint mode instead of mixing namespaces', async () => {
  const project = await mkdtemp(join(tmpdir(), 'soxu-status-local-'));
  const script = join(TOOL_ROOT, 'automation/loop/src/cli.mjs');
  try {
    await mkdir(join(project, 'tasks/backlog'), {recursive:true});
    await mkdir(join(project, 'automation'), {recursive:true});
    await mkdir(join(project, '.soxu/checkpoints'), {recursive:true});
    // The CLI validates project policy at startup; reuse the target project's own file.
    await writeFile(join(project, 'automation/policy.json'), await readFile(join(ROOT, 'automation/policy.json')));
    await writeFile(join(project, 'tasks/backlog/TASK-001.md'), '# Finished task');
    await writeFile(join(project, 'tasks/backlog/TASK-002.md'), '# Untouched task');
    await writeFile(join(project, '.soxu/checkpoints/github-issue-1.json'), JSON.stringify({
      schemaVersion: 2, local: false, status: 'done', phase: 'done',
      issue: {number: 1, title: '[TASK-001] Finished task'}
    }));
    await writeFile(join(project, '.soxu/checkpoints/local-issue-2.json'), JSON.stringify({
      schemaVersion: 2, local: true, status: 'paused', phase: 'checks',
      issue: {number: 2, title: '[TASK-002] Untouched task'}
    }));
    const env = {...process.env, SOXU_PROJECT_ROOT: project};
    delete env.SOXU_DATA_DIR;
    const {stdout} = await execFileAsync(process.execPath, [script, 'status', '--local', '--json'], {cwd:project, env, timeout:10000});
    const snapshot = JSON.parse(stdout);
    // Local-queue mode must not borrow GitHub-mode progress.
    assert.deepEqual(snapshot.done.map(x => x.id), []);
    assert.deepEqual(snapshot.paused.map(x => x.id), [2]);
    const {stdout: human} = await execFileAsync(process.execPath, [script, 'status', '--local'], {cwd:project, env, timeout:10000});
    assert.match(human, /local-queue mode/);
    const {stdout: github} = await execFileAsync(process.execPath, [script, 'status'], {cwd:project, env, timeout:10000});
    assert.match(github, /GitHub-issue mode/);
    assert.match(github, /#1 Finished task/);
  } finally { await rm(project, {recursive:true, force:true}); }
});

test('missing H1 uses TASK id instead of blank title', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soxu-status-fallback-'));
  try {
    await mkdir(join(root, 'tasks/backlog'), {recursive:true});
    await writeFile(join(root, 'tasks/backlog/TASK-011.md'), 'No title here');
    const snapshot = await localProgress(root, async () => null);
    assert.equal(snapshot.pending[0].title, 'TASK-011');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('status CLI renders task headings and JSON includes titles', async () => {
  const script = join(TOOL_ROOT, 'automation/loop/src/cli.mjs');
  const {stdout} = await execFileAsync(process.execPath, [script, 'status'], {cwd:ROOT, timeout:10000});
  for (const id of ['001', '002']) {
    const markdown = await readFile(join(ROOT, `tasks/backlog/TASK-${id}.md`), 'utf8');
    const title = markdown.match(/^#[ \t]+(.+)$/m)?.[1].trim();
    assert.ok(title && stdout.includes(`#${Number(id)} ${title}`), `Missing status heading for TASK-${id}`);
  }
  assert.doesNotMatch(stdout, /#1 -(?:\r?\n|$)/);
  const {stdout: json} = await execFileAsync(process.execPath, [script, 'status', '--json'], {cwd:ROOT, timeout:10000});
  const snapshot = JSON.parse(json);
  const items = [...snapshot.pending, ...snapshot.running, ...snapshot.paused, ...snapshot.blocked, ...snapshot.done];
  for (const id of ['001', '002']) {
    const markdown = await readFile(join(ROOT, `tasks/backlog/TASK-${id}.md`), 'utf8');
    const title = markdown.match(/^#[ \t]+(.+)$/m)?.[1].trim();
    assert.equal(items.find(item => item.id === Number(id))?.title, title);
  }
});
