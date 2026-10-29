import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyFailure, isRecoverable, safeFailureMessage } from "../src/errors.mjs";
import { writeCheckpoint, readCheckpoint, listPaused } from "../src/checkpoint.mjs";
import { resolvePiTimeouts } from "../src/rpc.mjs";

test("quota and network are recoverable; security failure is not", () => {
  for (const error of ["HTTP 429 Too Many Requests", "insufficient_quota", "resource_exhausted"]) {
    assert.equal(classifyFailure(new Error(error)).kind, "quota");
    assert.equal(isRecoverable(new Error(error)), true);
  }
  for (const error of ["ECONNRESET", "fetch failed", "HTTP 503"])
    assert.equal(classifyFailure(new Error(error)).kind, "network");
  assert.equal(isRecoverable(new Error("Review rejected")), false);
  assert.equal(classifyFailure(new Error("HTTP 401 unauthorized")).kind, "auth");
  assert.ok(!safeFailureMessage(new Error("Bearer supersecrettoken" )).includes("supersecrettoken"));
});

test("durable checkpoints preserve exact phase, and discover paused or interrupted only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soxu-checkpoint-"));
  try {
    const task = { issue: { number: 412, title: "Example", body: "anything" }, local: true, status: "paused", phase: "review", attempt: 1, directory: "/some/worktree", branch: "agent/issue-412-example" };
    await writeCheckpoint(task, dir);
    assert.equal((await readCheckpoint(412,dir,true)).phase, "review");
    assert.equal((await listPaused(dir)).length,1);
    await writeCheckpoint({ ...task, status: "running", phase: "checks" }, dir);
    assert.equal((await listPaused(dir))[0].phase,"checks");
    await writeCheckpoint({ ...task, status: "done" }, dir);
    assert.equal((await listPaused(dir)).length,0);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("startup, idle and hard deadline budgets are separated", () => {
  assert.deepEqual(resolvePiTimeouts({timeouts:{piStartupSeconds:90,piIdleSeconds:240,piHardMinutes:35,shutdownGraceSeconds:5}}), {startupMs:90000,baseIdleMs:240000,hardMs:2100000,graceMs:5000});
  assert.equal(resolvePiTimeouts({timeoutMs:1500}).hardMs,1500);
  assert.throws(() => resolvePiTimeouts({timeoutMs:-1}));
});

test("blocked checkpoints require explicit inclusion and Connection error is recoverable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soxu-blocked-"));
  try {
    await writeCheckpoint({issue:{number:12}, status:"blocked", phase:"checks"}, dir);
    assert.equal((await listPaused(dir)).length, 0);
    assert.equal((await listPaused(dir, {includeBlocked:true}))[0].phase, "checks");
    assert.equal(classifyFailure(new Error("Pi assistant error: Connection error.")).kind, "network");
    assert.equal(isRecoverable(new Error("Pi assistant error: Connection error.")), true);
  } finally { await rm(dir, {recursive:true, force:true}); }
});
