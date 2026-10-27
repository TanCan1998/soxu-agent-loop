import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRoleModels, modelArgs, loadRoleModels } from '../src/agent-models.mjs';
import { runPi } from '../src/rpc.mjs';

const empty = {schemaVersion: 1, roles: {
  developer: {provider: null, model: null, thinking: null},
  reviewer: {provider: null, model: null, thinking: null}
}};

test('model roles inherit defaults unless explicitly configured', () => {
  assert.deepEqual(resolveRoleModels(empty, {}), {
    developer: {provider:null,model:null,thinking:null},
    reviewer: {provider:null,model:null,thinking:null}
  });
  assert.deepEqual(modelArgs({}), []);
});

test('per-role overrides are independent and never need API credentials in project', () => {
  const settings = resolveRoleModels(empty, {
    SOXU_DEVELOPER_PROVIDER: 'openai', SOXU_DEVELOPER_MODEL: 'gpt-5.1-codex', SOXU_DEVELOPER_THINKING:'high',
    SOXU_REVIEWER_PROVIDER: 'google', SOXU_REVIEWER_MODEL:'gemini-2.5-pro'
  });
  assert.deepEqual(modelArgs(settings.developer), ['--provider','openai','--model','gpt-5.1-codex','--thinking','high']);
  assert.deepEqual(modelArgs(settings.reviewer), ['--provider','google','--model','gemini-2.5-pro']);
});

test('invalid or partial model values fail closed instead of silently selecting a paid model', () => {
  assert.throws(() => resolveRoleModels(empty, {SOXU_DEVELOPER_PROVIDER:'openai'}), /both/);
  assert.throws(() => resolveRoleModels(empty, {SOXU_DEVELOPER_PROVIDER:'openai',SOXU_DEVELOPER_MODEL:'x & curl bad'}), /Invalid/);
  assert.throws(() => resolveRoleModels(empty, {SOXU_REVIEWER_THINKING:'unlimited'}), /thinking/);
  assert.throws(() => modelArgs({ provider: 'openai', model: '--danger' }), /Invalid/);
});

test('checked-in Magpie model is selected for developer and reviewer', async () => {
  const roles = await loadRoleModels({});
  for (const role of ['developer', 'reviewer']) {
    assert.deepEqual(roles[role], {provider:'magpie', model:'auto/deepseek-v4.1-flash', thinking:null});
    assert.deepEqual(modelArgs(roles[role]), ['--provider','magpie','--model','auto/deepseek-v4.1-flash']);
  }
});

test('Magpie checked-in model can be overridden only by explicit complete runtime choice', async () => {
  const models = await loadRoleModels({ SOXU_DEVELOPER_PROVIDER:'magpie', SOXU_DEVELOPER_MODEL:'auto/deepseek-v4.1-flash' });
  assert.equal(models.developer.model,'auto/deepseek-v4.1-flash');
  assert.deepEqual(modelArgs(models.developer), ['--provider','magpie','--model','auto/deepseek-v4.1-flash']);
});

test('RPC forwards explicit model flags and persists Pi sessions', {skip:process.platform==='win32'}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soxu-role-model-'));
  const mock = join(dir,'fake-pi');
  const capture = join(dir,'argv.json');
  const previous = process.env.SOXU_PI_BIN;
  try {
    await writeFile(mock, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));
process.stdin.on('data',data=>{
 const input=JSON.parse(data.toString().trim());
 if(input.type==='prompt'){
  process.stdout.write(JSON.stringify({type:'response',id:input.id,success:true,data:{disposition:'started'}})+'\\n');
  process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
  process.stdin.end();
 }
});
`);
    await chmod(mock,0o755);
    process.env.SOXU_PI_BIN=mock;
    await runPi({cwd:dir,prompt:'Inspect model routing', timeoutMs:3000, modelSelection:{provider:'openai',model:'gpt-5.1-codex',thinking:'high'}});
    assert.deepEqual(JSON.parse(await readFile(capture,'utf8')),[
      '--mode','rpc','--provider','openai','--model','gpt-5.1-codex','--thinking','high'
    ]);
  } finally {
    if(previous===undefined) delete process.env.SOXU_PI_BIN;
    else process.env.SOXU_PI_BIN=previous;
    await rm(dir,{recursive:true,force:true});
  }
});
