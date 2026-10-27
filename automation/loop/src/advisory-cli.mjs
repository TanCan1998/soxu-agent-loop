#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT } from './config.mjs';
import { evaluateLessons } from './lessons.mjs';
import { runAdvisory } from './advisory.mjs';

const [command,...args]=process.argv.slice(2).filter(x=>x!=='--');
const help=args.includes('--help') || command==='help' || !command;
if(help) {
  console.log(`SOXU advisory lanes (opt-in; no recurring background process)\n
  product   Analyze product/Issue gaps; emits local proposal only
  quality   Review recent commits/CI/lessons; emits local proposal only
  lessons   List repeat observations eligible for manual rule promotion

Options: --dry-run (no model, no network or files written), --offline (skip GitHub reads), --json (structured output)

Commands: pnpm agent:product -- --dry-run; pnpm agent:quality; pnpm agent:lessons -- --json`);
  process.exit(0);
}
if(!['product','quality','lessons'].includes(command)) throw new Error(`Unknown lane: ${command}`);
const allowed=new Set(['--dry-run','--offline','--json']);
for(const arg of args) if(!allowed.has(arg)) throw new Error(`Unknown option: ${arg}`);
const dryRun=args.includes('--dry-run');
const json=args.includes('--json');
if(command==='lessons') {
  const content=await readFile(resolve(ROOT,'LESSONS.md'),'utf8');
  const rows=evaluateLessons(content);
  if(json) console.log(JSON.stringify({thresholdDistinctDays:3,lessons:rows},null,2));
  else {
    console.log(`Lessons: ${rows.length} tracked; ${rows.filter(x=>x.eligible).length} eligible for proposal (never auto-promoted)`);
    for(const row of rows) console.log(`${row.id}: ${row.days} distinct days; ${row.eligible?'REVIEW REQUIRED':'not yet eligible'}`);
  }
} else {
  const ctl=new AbortController();
  for(const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>ctl.abort());
  const result=await runAdvisory(command,{dryRun,github:!args.includes('--offline'),signal:ctl.signal});
  if(json) console.log(JSON.stringify(result,null,2));
  else if(dryRun) console.log(`${command} advisory dry-run: ${result.sources.map(x=>x.source).join(', ')}; NO model call/network/write`);
  else console.log(`${command} advisory: LOCAL proposal written to ${result.path}\nNothing was pushed, merged, published or added as an Issue.`);
}
