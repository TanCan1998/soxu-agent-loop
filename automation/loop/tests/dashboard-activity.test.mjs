import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiActivityReporter, safeActivity } from "../src/dashboard-activity.mjs";

test("reports only role, task, state, tool and timestamp", () => {
  const events = [];
  let time = 0;
  const now = () => new Date(Date.UTC(2026, 9, 27, 0, 0, time++)).toISOString();
  const reporter = createPiActivityReporter(7, "developer", { send: msg => events.push(msg), now });
  reporter.onEvent({ type:"tool_execution_start", toolName:"read", args:{ API_KEY:"secret-value" }, path:"/private/path" });
  reporter.onEvent({ type:"tool_execution_end", result:"private model response" });
  reporter.onEvent({ type:"message_update", assistantMessageEvent:{ type:"text_delta", delta:"private text" } });
  reporter.finish(true);
  assert.deepEqual(events.map(e=>e.data.state),["waiting","tool","waiting","generating","completed"]);
  assert.equal(events[1].data.tool,"read");
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(),["data","type"]);
    assert.deepEqual(Object.keys(e.data).sort(),["activitySince","role","startedAt","state","taskId","tool"]);
    for(const secret of ["secret-value","private/path","private model response","private text"])
      assert.ok(!JSON.stringify(e).includes(secret));
    assert.deepEqual(safeActivity(e.data), e.data);
  }
});
test("ignores RPC events carrying raw text without leaking anything", () => {
  const events=[];
  const r=createPiActivityReporter(1,"reviewer",{send:x=>events.push(x)});
  r.onEvent({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"password=secret"}});
  r.onEvent({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"new text"}});
  r.onEvent({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"secret"}]}});
  assert.equal(events.length,3);
  assert.ok(!JSON.stringify(events).includes("secret"));
});
test("untrusted tool names and malformed data are rejected", () => {
  const events=[];
  const r=createPiActivityReporter(1,"developer",{send:x=>events.push(x)});
  r.onEvent({type:"tool_execution_start",toolName:"token=private"});
  assert.equal(events.at(-1).data.tool,null);
  assert.equal(safeActivity({...events.at(-1).data, tool:"../../secret"}).tool,null);
  assert.equal(safeActivity({...events.at(-1).data, role:"admin"}),null);
  assert.equal(safeActivity({...events.at(-1).data, taskId:-1}),null);
  assert.equal(safeActivity({role:"developer",taskId:1,state:"tool"}),null);
});
test("failure has separate terminal status without raw exceptions", () => {
  const events=[];
  const r=createPiActivityReporter(1,"reviewer",{send:x=>events.push(x)});
  r.onEvent({type:"agent_error",message:"api_key=secret"});
  r.finish(false);
  assert.equal(events.at(-1).data.state,"failed");
  assert.ok(!JSON.stringify(events).includes("secret"));
});
