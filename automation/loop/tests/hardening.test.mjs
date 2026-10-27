import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, run } from '../src/process.mjs';
import { inspectChanges } from '../src/guards.mjs';
import { assertRecoveredCommit } from '../src/review-invariants.mjs';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'soxu-hardening-'));
  await git(['init', '-q'], dir);
  await git(['config', 'user.email', 'test@example.invalid'], dir);
  await git(['config', 'user.name', 'SOXU Test'], dir);
  await writeFile(join(dir, 'base.txt'), 'base\n');
  await git(['add', 'base.txt'], dir);
  await git(['commit', '-qm', 'initial'], dir);
  return { dir, base: await git(['rev-parse', 'HEAD'], dir), policy: {
    maxChangedFiles: 80, maxChangedBytes: 1024, protectedPaths: ['AGENTS.md', 'automation/policy.json']
  } };
}

test('large binary payload cannot bypass byte budget through Git numstat dash markers', async () => {
  const { dir, base, policy } = await setup();
  try {
    await writeFile(join(dir, 'oversize.bin'), Buffer.alloc(2048, 0));
    await assert.rejects(inspectChanges(dir, base, policy), /byte budget/);
    await rm(join(dir, 'oversize.bin'));
    await writeFile(join(dir, 'small.bin'), Buffer.alloc(200, 0));
    assert.deepEqual(await inspectChanges(dir, base, policy), ['small.bin']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('symlink changes are rejected rather than following files outside the worktree', {skip:process.platform === 'win32'}, async () => {
  const { dir, base, policy } = await setup();
  try {
    await symlink('/etc/passwd', join(dir, 'linked.txt'));
    await assert.rejects(inspectChanges(dir, base, policy), /Symbolic link changes/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('resume accepts only a commit with exact tested/reviewed tree and expected parent', async () => {
  const { dir, base, policy } = await setup();
  try {
    await writeFile(join(dir, 'base.txt'), 'approved implementation\n');
    await inspectChanges(dir, base, policy);
    const tree = await git(['write-tree'], dir);
    const state = { issue: {number:17}, base, testedTree:tree, reviewedTree:tree };
    await git(['commit', '-qm', '✨ feat(agent): resolve Issue #17'], dir);
    const evidence = {
      head: await git(['rev-parse', 'HEAD'],dir),
      parent: await git(['rev-parse', 'HEAD^'],dir),
      tree: await git(['rev-parse', 'HEAD^{tree}'],dir),
      subject: await git(['log','-1','--format=%s'],dir)
    };
    assert.doesNotThrow(() => assertRecoveredCommit(state, evidence));
    assert.throws(() => assertRecoveredCommit({...state, reviewedTree:'other'}, evidence), /manual inspection/);
    assert.throws(() => assertRecoveredCommit(state, {...evidence, parent:'another-parent'}), /manual inspection/);
    assert.throws(() => assertRecoveredCommit(state, {...evidence, subject:'✨ feat(agent): resolve Issue #999'}), /manual inspection/);
    await writeFile(join(dir,'base.txt'),'different commit content\n');
    await git(['add','base.txt'],dir);
    await git(['commit','--amend','--no-edit'],dir);
    const amended = { ...evidence, head: await git(['rev-parse','HEAD'],dir), tree: await git(['rev-parse','HEAD^{tree}'],dir) };
    assert.throws(() => assertRecoveredCommit(state, amended), /manual inspection/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('external command abort waits for process exit before permitting recovery', {skip:process.platform === 'win32'}, async () => {
  const dir=await mkdtemp(join(tmpdir(),'soxu-abort-'));
  const file=join(dir,'child-pid.txt');
  const controller=new AbortController();
  try {
    const script=join(dir,'run.js');
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000);`);
    setTimeout(()=>controller.abort(),300);
    const err=await run(process.execPath,[script],{cwd:dir,signal:controller.signal,timeoutMs:5000}).then(()=>null,x=>x);
    assert.equal(err.kind,'interrupted');
    const pid=Number(await readFile(file,'utf8'));
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('Pi success is not returned until its RPC process has exited', {skip: process.platform === 'win32'}, async () => {
  const { runPi } = await import('../src/rpc.mjs');
  const { chmod } = await import('node:fs/promises');
  const dir=await mkdtemp(join(tmpdir(),'soxu-rpc-exit-'));
  const bin=join(dir,'fake-pi');
  const previous=process.env.SOXU_PI_BIN;
  try {
    await writeFile(bin, `#!/usr/bin/env node
process.stdin.on('data',c=>{const m=JSON.parse(c.toString().trim());if(m.type==='prompt'){
process.stdout.write(JSON.stringify({type:'response',id:m.id,success:true,data:{disposition:'started'}})+'\\n');
process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
setTimeout(()=>process.exit(0),230);
}});
`);
    await chmod(bin,0o755);
    process.env.SOXU_PI_BIN=bin;
    const started=Date.now();
    const output=await runPi({cwd:dir,prompt:'test',timeoutMs:3000,timeouts:{shutdownGraceSeconds:1}});
    assert.equal(typeof output.text,'string');
    assert.ok(Date.now()-started>=190,'Runner must wait for child close after agent_settled');
  } finally {
    if(previous===undefined) delete process.env.SOXU_PI_BIN; else process.env.SOXU_PI_BIN=previous;
    await rm(dir,{recursive:true,force:true});
  }
});
