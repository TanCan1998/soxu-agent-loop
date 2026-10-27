import {test} from "node:test";
import assert from "node:assert/strict";
import {run} from "../src/process.mjs";
import {prepareCheckRepair} from "../src/worker.mjs";
test("check stdout diagnostics survive and one bounded repair preserves secret redaction",async()=>{
  let failure;
  try {await run(process.execPath,["-e","console.log('src/example.ts:42 error TS1234');console.error('password=secret-example');process.exit(1)"]);}catch(error){failure=error;}
  assert.equal(failure.exitCode,1);assert.match(failure.message,/TS1234/);
  const state={};assert.equal(prepareCheckRepair(state,failure,1),true);
  assert.match(state.feedback,/TS1234/);assert.doesNotMatch(state.feedback,/secret-example/);
  assert.equal(prepareCheckRepair(state,failure,1),false);
});
test("network errors and non-command failures never trigger developer repair",()=>{
  assert.equal(prepareCheckRepair({},Object.assign(new Error("network"),{kind:"network",exitCode:1}),1),false);
  assert.equal(prepareCheckRepair({},new Error("protected path"),1),false);
});
