import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { join } from "node:path";
import { ROOT, TOOL_ROOT } from "../src/config.mjs";

test("IPC-launched coordinator exits after finished command", async () => {
  const script=join(TOOL_ROOT,"automation/loop/src/cli.mjs");
  const child=fork(script,["status"],{cwd:ROOT,stdio:["ignore","pipe","pipe","ipc"],windowsHide:true});
  let stdout="";
  child.stdout.on("data",chunk=>{stdout+=String(chunk);});
  const outcome=await new Promise((resolve,reject)=>{
    const deadline=setTimeout(()=>{child.kill();reject(new Error("IPC channel kept completed runner alive"));},8000);
    child.once("error",error=>{clearTimeout(deadline);reject(error);});
    child.once("exit",(code,signal)=>{clearTimeout(deadline);resolve({code,signal});});
  });
  assert.equal(outcome.code,0);
  assert.match(stdout,/SOXU offline task status/);
});
