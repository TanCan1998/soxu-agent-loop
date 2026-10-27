import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.mjs';

const load = path => readFile(resolve(ROOT,path),'utf8');

test('Chinese and English README are present with reciprocal navigation and matching commands', async () => {
  const zh=await load('README.md');
  const en=await load('README.en.md');
  assert.match(zh, /\[English\]\(README\.en\.md\)/);
  assert.match(en, /\[简体中文\]\(README\.md\)/);
  for(const [legacy, current] of [['pnpm agent:models','cli.mjs models'],['pnpm agent:status','cli.mjs status'],['pnpm agent:doctor','cli.mjs doctor'],['pnpm agent:start','cli.mjs start'],['pnpm agent:loop','cli.mjs loop'],['pnpm agent:dashboard','dashboard-cli.mjs'],['pnpm tauri:dev','pnpm tauri:dev']]) {
    assert.ok(zh.includes(legacy) || zh.includes(current), `Chinese README missing ${current}`);
    assert.ok(en.includes(legacy) || en.includes(current), `English README missing ${current}`);
  }
  assert.match(zh, /agent:logs.*尚未实现/);
  assert.match(en, /agent:logs.*not implemented/);
  assert.match(zh, /magpie/);
  assert.match(en, /magpie/);
});

test('product acceptance and governance point to measurable gates', async () => {
  const prd=await load('docs/product/prd.md');
  const agents=await load('AGENTS.md');
  const policy=JSON.parse(await load('automation/policy.json'));
  for(let i=1;i<=8;i++) assert.match(prd,new RegExp(`P-0${i}`));
  assert.match(agents, /README\.en\.md/);
  assert.ok(policy.protectedPaths.includes('automation/agent-models.json'));
  assert.match(await load('agents/policies/model-selection.md'), /Reviewer/);
});
