import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readLaneStatus} from "../src/dashboard-lanes.mjs";

test("lane reports are read-only metadata and lesson thresholds use distinct dates",async()=>{
  const root=await mkdtemp(join(tmpdir(),"soxu-lanes-"));
  try {
    await mkdir(join(root,".soxu","advisory","product"),{recursive:true});
    await writeFile(join(root,".soxu","advisory","product","2026-10-27T00-00-00-000Z-123.json"),"sensitive report text");
    const row=date=>`<!-- soxu-lesson ${JSON.stringify({id:"example-rule",date,evidence:"#1",rule:"Verify the evidence before promotion"})} -->`;
    await writeFile(join(root,"LESSONS.md"),[row("2026-10-25"),row("2026-10-26"),row("2026-10-27")].join("\n"));
    const value=await readLaneStatus(root);
    assert.equal(value.product.count,1);assert.equal(value.quality.status,"empty");
    assert.deepEqual(value.lessons,{status:"available",count:1,eligible:1});
    assert.ok(!JSON.stringify(value).includes("sensitive report text"));
  }finally{await rm(root,{recursive:true,force:true});}
});
