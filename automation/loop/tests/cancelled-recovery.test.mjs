import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {writeCheckpoint,listPaused,readCheckpoint} from "../src/checkpoint.mjs";

test("cancelled tasks cannot be resumed, while their checkpoints are preserved",async()=>{
  const root=await mkdtemp(join(tmpdir(),"soxu-cancel-"));
  const dir=join(root,".soxu","checkpoints"), markers=join(root,"tasks","cancelled");
  try {
    await mkdir(markers,{recursive:true});
    await writeFile(join(markers,"TASK-005.json"),JSON.stringify({taskId:"TASK-005",githubIssue:5}));
    await writeCheckpoint({issue:{number:5,title:"[TASK-005] original"},status:"paused",phase:"createPr"},dir);
    await writeCheckpoint({issue:{number:6,title:"[M4] [TASK-006] other"},status:"paused",phase:"develop"},dir);
    await writeCheckpoint({issue:{number:5,title:"[TASK-005] local"},local:true,status:"blocked",phase:"develop"},dir);
    const list=await listPaused(dir,{includeBlocked:true});
    assert.deepEqual(list.map(s=>s.issue.number),[6]);
    assert.equal((await readCheckpoint(5,dir,false)).phase,"createPr");
    assert.equal((await readCheckpoint(5,dir,true)).status,"blocked");
  } finally {await rm(root,{recursive:true,force:true});}
});
