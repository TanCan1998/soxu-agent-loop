import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const migrate=fileURLToPath(new URL("../src/migrate-data.mjs",import.meta.url));
const cli=fileURLToPath(new URL("../src/cli.mjs",import.meta.url));
test("migration preserves legacy checkpoint and rejects wrong project binding",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"soxu-migrate-")), project=join(dir,"project"), target=join(dir,"data");
 try {
  await mkdir(join(project,".soxu/checkpoints"),{recursive:true});await mkdir(join(project,"automation"));await mkdir(join(project,"tasks/backlog"),{recursive:true});
  await cp(join(process.env.SOXU_PROJECT_ROOT,"automation/policy.json"),join(project,"automation/policy.json"));
  await writeFile(join(project,"tasks/backlog/TASK-001.md"),"# Target task\n");
  const saved=JSON.stringify({issue:{number:1,title:"[TASK-001] Target task"},local:true,status:"paused",phase:"checks"});
  await writeFile(join(project,".soxu/checkpoints/issue-1.json"),saved);
  const run=spawnSync(process.execPath,[migrate,project,target,"--offline"],{encoding:"utf8"});assert.equal(run.status,0,run.stderr);
  assert.equal(await readFile(join(project,".soxu/checkpoints/issue-1.json"),"utf8"),saved);
  const env={...process.env,SOXU_PROJECT_ROOT:project,SOXU_DATA_DIR:target};
  const status=spawnSync(process.execPath,[cli,"status","--local","--json"],{env,encoding:"utf8"});
  if(status.status!==0) console.error("migration diagnostic",JSON.stringify({project,marker:await readFile(join(target,".soxu-project.json"),"utf8")}));
  assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).paused[0].phase,"checks");
  const resume=spawnSync(process.execPath,[cli,"start","--local","--dry-run"],{env,encoding:"utf8"});assert.equal(resume.status,0,resume.stderr);assert.match(resume.stdout,/would recover #1 at checks/);
  const other=join(dir,"other");await mkdir(other);const wrong=spawnSync(process.execPath,[cli,"status"],{env:{...env,SOXU_PROJECT_ROOT:other},encoding:"utf8"});assert.notEqual(wrong.status,0);assert.match(wrong.stderr,/different project/);
  const repeated=spawnSync(process.execPath,[migrate,project,target,"--offline"],{encoding:"utf8"});assert.notEqual(repeated.status,0);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test("migration refuses when an old task lock exists",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"soxu-locked-")), project=join(dir,"project");
 try {await mkdir(join(project,".soxu/locks"),{recursive:true});await writeFile(join(project,".soxu/locks/github-issue-5.lock"),"{}");
 const run=spawnSync(process.execPath,[migrate,project,join(dir,"data"),"--offline"],{encoding:"utf8"});assert.notEqual(run.status,0);assert.match(run.stderr,/locks must be investigated/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
