import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DashboardCoordinator, createDashboardServer } from "../src/dashboard.mjs";

const TOKEN = "a".repeat(48);
const githubStatus = async () => ({});
async function cleanup(root, coordinator) {
  coordinator.shutdown();
  await Promise.allSettled([coordinator.intake.initialized, coordinator.githubPending, coordinator.lanesPending].filter(Boolean));
  await rm(root, {recursive:true, force:true, maxRetries:5, retryDelay:100});
}
async function startServer(coordinator) {
  const options = { root:coordinator.root, token:TOKEN, coordinator };
  const dashboard = createDashboardServer(options);
  await new Promise((resolve, reject) => dashboard.server.listen(0,"127.0.0.1",resolve).once("error",reject));
  return { ...dashboard, port:dashboard.server.address().port };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(),"soxu-live-"));
  await mkdir(join(root,"tasks","backlog"), {recursive:true});
  await writeFile(join(root,"tasks","backlog","TASK-001.md"), "# Streaming\n");
  return root;
}
function connect(port, token) {
  return new Promise((resolve,reject) => {
    const req=request({host:"127.0.0.1",port,path:"/api/events",headers:{
      ...(token ? { "X-SOXU-Control-Token":token } : {})
    }}, res=>resolve({req,res}));
    req.on("error",reject);
    req.end();
  });
}
test("SSE requires token and streams only validated bounded event metadata",async()=>{
  const root=await setup();
  const children=[];
  const coordinator=new DashboardCoordinator({root, githubStatus, spawn:()=>{
    const child=new EventEmitter();
    child.connected=true;
    child.pid=98765;
    child.stdout=new PassThrough();
    child.stderr=new PassThrough();
    child.send=()=>{};
    children.push(child);
    return child;
  }});
  const server=await startServer(coordinator);
  let session;
  try {
    const unauthorized=await connect(server.port,null);
    assert.equal(unauthorized.res.statusCode,401);
    unauthorized.res.resume();
    session=await connect(server.port,TOKEN);
    assert.equal(session.res.statusCode,200);
    assert.match(session.res.headers["content-type"],/text\/event-stream/);
    const frames=[];
    session.res.setEncoding("utf8");
    session.res.on("data", chunk=>frames.push(chunk));
    await coordinator.start("start");
    const invalid={type:"soxu:activity",data:{taskId:1,role:"developer",state:"tool",tool:"token=secret",startedAt:"2026-10-27T00:00:00.000Z",activitySince:"2026-10-27T00:00:01.000Z",private:"secret"}};
    children[0].emit("message",invalid);
    coordinator.push("api_key=private-value","stderr");
    const result=await coordinator.snapshot();
    assert.equal(result.agents[0].tool,null);
    assert.equal(result.schemaVersion,2);
    assert.ok(!JSON.stringify(result).includes("private-value"));
    await new Promise(resolve=>setImmediate(resolve));
    assert.match(frames.join(""),/event: hello/);
    assert.match(frames.join(""),/event: agent/);
    assert.match(frames.join(""),/event: log/);
    assert.ok(!frames.join("").includes("private-value"));
    assert.ok(!frames.join("").includes("token=secret"));
    children[0].emit("exit",0,null);
  } finally {
    session?.res.destroy();
    session?.req.destroy();
    server.stopStreams();
    await new Promise(resolve=>server.server.close(resolve));
    await cleanup(root,coordinator);
  }
});
test("server memory keeps at most 500 logs and 32 agent cards",async()=>{
  const root=await setup(), coordinator=new DashboardCoordinator({root,githubStatus});
  try {
    for(let i=0;i<650;i++)coordinator.push("line " + i);
    const s=await coordinator.snapshot();
    assert.equal(s.log.length,500);
    assert.equal(s.log[0].seq,151);
    assert.equal(s.log.at(-1).seq,650);
  } finally {await cleanup(root,coordinator);}
});
