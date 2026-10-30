import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectProcess, readEntries, registerProcess, registryFile, sweepProcesses, taskKey } from "../src/process-registry.mjs";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const pad = value => String(value).padStart(2, "0");

/** 按当前平台伪造 `inspectProcess` 需要的输出，让用例在 win/mac/linux 都能跑。 */
function fakeExecute(live) {
  return async (bin, args) => {
    if (bin === "pwsh") {
      const script = String(args[args.length - 1] ?? "");
      const pid = Number(/ProcessId=(\d+)/.exec(script)?.[1]);
      const entry = live.get(pid);
      if (!entry) return { code: 0, stdout: "", stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify({ ProcessId: pid, CommandLine: entry.command, CreationDate: new Date(entry.startedAtMs).toISOString() }),
        stderr: "",
      };
    }
    if (bin === "ps") {
      const pid = Number(args[args.length - 1]);
      const entry = live.get(pid);
      if (!entry) return { code: 1, stdout: "", stderr: "" };
      const d = new Date(entry.startedAtMs);
      const lstart = `${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
      return { code: 0, stdout: `${pid} ${lstart} ${entry.command}\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "soxu-pid-registry-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}

test("taskKey mirrors the worktree naming so humans can match them up", () => {
  assert.equal(taskKey({ number: 42 }), "github-issue-42");
  assert.equal(taskKey({ number: 42 }, true), "local-issue-42");
});

test("a registered pid is written with command and start time, and re-registering replaces it", async () => {
  await withRoot(async root => {
    const started = Date.now() - 60_000;
    const live = new Map([[4242, { command: "node tauri.js dev", startedAtMs: started }]]);
    const execute = fakeExecute(live);
    await registerProcess({ root, key: "github-issue-7", pid: 4242, execute });
    await registerProcess({ root, key: "github-issue-7", pid: 4242, execute });
    const entries = await readEntries(root, "github-issue-7");
    assert.equal(entries.length, 1, "same pid must not be registered twice");
    assert.equal(entries[0].pid, 4242);
    assert.match(entries[0].command, /tauri/);
    // `ps -o lstart=` 只有秒级精度，因此这里允许 1s 误差（指纹比较的容差是 2s）。
    assert.ok(Math.abs(entries[0].startedAtMs - started) <= 1_000, "start time must match within ps precision");
    const raw = JSON.parse(await readFile(registryFile(root, "github-issue-7"), "utf8"));
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.key, "github-issue-7");
  });
});

test("sweep kills only the registered process whose fingerprint still matches", async () => {
  await withRoot(async root => {
    const base = Date.now() - 120_000;
    const live = new Map([[111, { command: "node tauri.js dev", startedAtMs: base }]]);
    const execute = fakeExecute(live);
    await registerProcess({ root, key: "k1", pid: 111, execute });
    const killed = [];
    const result = await sweepProcesses({
      root, key: "k1", execute,
      kill: async pid => { killed.push(pid); live.delete(pid); },
    });
    assert.deepEqual(killed, [111]);
    assert.deepEqual(result.killed, [111]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(await readEntries(root, "k1"), [], "a killed pid must not stay registered");
  });
});

test("a reused pid is skipped instead of killed", async () => {
  await withRoot(async root => {
    const started = Date.now() - 120_000;
    const live = new Map([[222, { command: "node tauri.js dev", startedAtMs: started }]]);
    const execute = fakeExecute(live);
    await registerProcess({ root, key: "k2", pid: 222, execute });
    live.set(222, { command: "node other-service.js", startedAtMs: started + 600_000 });
    const killed = [];
    const result = await sweepProcesses({ root, key: "k2", execute, kill: async pid => { killed.push(pid); } });
    assert.deepEqual(killed, [], "must never kill a recycled pid");
    assert.equal(result.skipped[0].reason, "pid-reused");
    assert.equal((await readEntries(root, "k2")).length, 1, "the record stays for manual inspection");
  });
});

test("an exited process is pruned without killing anything", async () => {
  await withRoot(async root => {
    const live = new Map([[333, { command: "node vite.js", startedAtMs: Date.now() - 5_000 }]]);
    const execute = fakeExecute(live);
    await registerProcess({ root, key: "k3", pid: 333, execute });
    live.delete(333);
    const killed = [];
    const result = await sweepProcesses({ root, key: "k3", execute, kill: async pid => { killed.push(pid); } });
    assert.deepEqual(killed, []);
    assert.equal(result.pruned, 1);
    assert.deepEqual(await readEntries(root, "k3"), []);
  });
});

test("without a start time the command fingerprint decides", async () => {
  await withRoot(async root => {
    const live = new Map([[444, { command: "node tauri.js dev", startedAtMs: null }]]);
    const execute = fakeExecute(live);
    await registerProcess({ root, key: "k4", pid: 444, command: "node tauri.js dev", execute });
    const killed = [];
    const matched = await sweepProcesses({ root, key: "k4", execute, kill: async pid => { killed.push(pid); } });
    assert.deepEqual(killed, [444], "same command must be treated as the same process");
    assert.deepEqual(matched.skipped, []);
  });
});

test("the ps output is parsed even when the test itself runs on windows", async () => {
  const startedAtMs = Date.parse("2026-10-30T11:22:33Z");
  const live = new Map([[777, { command: "node tauri.js dev", startedAtMs }]]);
  const info = await inspectProcess(777, { execute: fakeExecute(live), platform: "linux" });
  assert.equal(info.pid, 777);
  assert.match(info.command, /tauri/);
  assert.equal(info.startedAtMs, startedAtMs);
});

test("sweeping one task never touches the registry of a parallel task", async () => {
  await withRoot(async root => {
    const live = new Map([
      [555, { command: "node a.js", startedAtMs: Date.now() - 1_000 }],
      [666, { command: "node b.js", startedAtMs: Date.now() - 1_000 }],
    ]);
    const execute = fakeExecute(live);
    await registerProcess({ root, key: "task-a", pid: 555, execute });
    await registerProcess({ root, key: "task-b", pid: 666, execute });
    const killed = [];
    await sweepProcesses({ root, key: "task-a", execute, kill: async pid => { killed.push(pid); } });
    assert.deepEqual(killed, [555]);
    assert.equal((await readEntries(root, "task-b")).length, 1, "the parallel task keeps its own record");
  });
});