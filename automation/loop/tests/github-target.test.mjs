import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {run,githubRepository} from "../src/process.mjs";

test("canonical GitHub remotes produce the same repository and reject credentials",()=>{
 assert.equal(githubRepository("https://github.com/Owner/repo.git"),"Owner/repo");
 assert.equal(githubRepository("git@github.com:Owner/repo.git"),"Owner/repo");
 assert.throws(()=>githubRepository("https://token@github.com/Owner/repo.git"));
});
test("GitHub commands refuse mismatched repository or push origin before invoking gh",async()=>{
 const root=await mkdtemp(join(tmpdir(),"soxu-target-"));
 try {
  await run("git",["init"],{cwd:root});await run("git",["remote","add","origin","https://github.com/owner/project.git"],{cwd:root});
  await assert.rejects(()=>run("gh",["issue","create"],{cwd:root,env:{...process.env,GH_REPO:"owner/other"}}),/GH_REPO does not match/);
  await assert.rejects(()=>run("gh",["pr","merge","https://github.com/owner/other/pull/1"],{cwd:root,env:{...process.env,GH_REPO:"owner/project"}}),/URL does not match/);
  await run("git",["remote","set-url","--push","origin","https://github.com/owner/other.git"],{cwd:root});
  await assert.rejects(()=>run("gh",["issue","create"],{cwd:root,env:{...process.env,GH_REPO:"owner/project"}}),/push origin do not match/);
 } finally {await rm(root,{recursive:true,force:true});}
});
