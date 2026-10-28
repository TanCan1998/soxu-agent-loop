import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { request } from "node:http";
import { DashboardCoordinator, createDashboardServer } from "../src/dashboard.mjs";
import {
  PROTOCOL_VERSION, writeRunnerState, readRunnerState, clearRunnerState,
  runnerCompatible, pidAlive, runnerStatePath, runnerStatus,
} from "../src/runner-state.mjs";
import { checkUpdate, applyUpdate } from "../src/update.mjs";
import { ROOT, TOOL_ROOT } from "../src/config.mjs";

const run = promisify(execFile);
const TOKEN = "b".repeat(48);
const githubStatus = async () => ({});
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(check, { timeout = 8000, interval = 50, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(interval);
  }
  throw new Error("Timed out waiting for " + label);
}

async function tempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, ".soxu"), { recursive: true });
  return root;
}

const RUNNER_FIXTURE = [
  'import { appendFileSync } from "node:fs";',
  'const [stateUrl, line] = process.argv.slice(2);',
  'const state = await import(stateUrl);',
  'const root = process.env.SOXU_PROJECT_ROOT;',
  'const logPath = state.runnerLogPath(root, process.pid);',
  'await state.writeRunnerState({ command: "start", pid: process.pid, logPath }, root);',
  'appendFileSync(logPath, line + "\\n");',
  'setInterval(() => {}, 1000);',
].join("\n");

/** Start a detached process that behaves like a runner left by a previous dashboard. */
async function startFixtureRunner(root, line = "fixture: working on task #5") {
  const dir = await mkdtemp(join(tmpdir(), "soxu-runner-script-"));
  const script = join(dir, "runner.mjs");
  await writeFile(script, RUNNER_FIXTURE);
  const stateUrl = pathToFileURL(join(TOOL_ROOT, "automation", "loop", "src", "runner-state.mjs")).href;
  const child = spawn(process.execPath, [script, stateUrl, line], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, SOXU_PROJECT_ROOT: root },
  });
  child.unref();
  await waitFor(async () => (await readRunnerState(root)) !== null, { label: "fixture runner state" });
  return { pid: child.pid, dir };
}

function killQuietly(pid) {
  if (!pid || !pidAlive(pid)) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).unref();
    else process.kill(pid, "SIGKILL");
  } catch {}
}

async function cleanup(root, coordinator) {
  if (coordinator) coordinator.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test("runner state records protocol identity and never adopts a mismatched protocol", async () => {
  const root = await tempRoot("soxu-runner-state-");
  try {
    await writeRunnerState({ command: "start", pid: process.pid }, root);
    const state = await readRunnerState(root);
    assert.equal(state.protocolVersion, PROTOCOL_VERSION);
    assert.equal(state.command, "start");
    assert.equal(runnerCompatible(state), true);
    assert.equal((await runnerStatus(root)).state, "running");

    // A runner from another protocol version must be reported, not silently adopted.
    await writeFile(runnerStatePath(root), JSON.stringify({ ...state, protocolVersion: PROTOCOL_VERSION + 1 }));
    const foreign = await readRunnerState(root);
    assert.equal(runnerCompatible(foreign), false);
    assert.equal((await runnerStatus(root)).state, "incompatible");

    // Only the owning pid may clear the record.
    assert.equal(await clearRunnerState(process.pid + 1, root), false);
    assert.equal(await clearRunnerState(process.pid, root), true);
    assert.equal(await readRunnerState(root), null);
  } finally { await cleanup(root); }
});

test("the CLI registers its runner before executing the command", async () => {
  // A hook placed after the awaited command only runs at exit, which silently breaks
  // reattachment; keep the registration ahead of the dispatch.
  const source = await readFile(new URL("../src/cli.mjs", import.meta.url), "utf8");
  const hook = source.indexOf('process.env.SOXU_RUNNER_STATE === "1"');
  const dispatch = source.indexOf("switch (command)");
  assert.ok(hook > 0, "runner registration hook missing");
  assert.ok(dispatch > 0, "command dispatch missing");
  assert.ok(hook < dispatch, "runner registration must precede command dispatch");
});

test("a restarted dashboard attaches to a live runner, replays its log and can stop it", async () => {
  const root = await tempRoot("soxu-runner-attach-");
  const runner = await startFixtureRunner(root, "fixture: resumed task work");
  const first = new DashboardCoordinator({ root, githubStatus, spawn: () => { throw new Error("must not spawn"); } });
  try {
    const snapshot = await first.snapshot();
    assert.equal(snapshot.runner.attached, true);
    assert.equal(snapshot.runner.pid, runner.pid);
    assert.equal(snapshot.runner.compatible, true);
    assert.equal(snapshot.busy, true);
    assert.ok(snapshot.log.some(line => line.message.includes("resumed task work")), "log tail must be replayed");

    // A second dashboard must not start a competing runner.
    await assert.rejects(() => first.start("start"), e => e.status === 409);

    const stop = first.stop();
    assert.equal(stop.accepted, true);
    await waitFor(() => !pidAlive(runner.pid), { label: "runner exit" });
    const after = await first.snapshot();
    assert.equal(after.runner, null);
    assert.equal(after.lastRun.command, "start");
  } finally {
    killQuietly(runner.pid);
    await cleanup(root, first);
  }
});

test("shutting the dashboard down leaves an attached runner working", async () => {
  const root = await tempRoot("soxu-runner-detach-");
  const runner = await startFixtureRunner(root);
  const coordinator = new DashboardCoordinator({ root, githubStatus });
  try {
    assert.equal((await coordinator.snapshot()).runner.attached, true);
    coordinator.shutdown();
    await sleep(200);
    assert.equal(pidAlive(runner.pid), true, "hot update must not interrupt a running task");
    assert.ok((await readRunnerState(root)).pid === runner.pid, "state must survive the dashboard");
  } finally {
    killQuietly(runner.pid);
    await cleanup(root, coordinator);
  }
});

test("an incompatible runner is visible but its controls are refused", async () => {
  const root = await tempRoot("soxu-runner-incompatible-");
  const runner = await startFixtureRunner(root);
  const coordinator = new DashboardCoordinator({ root, githubStatus });
  try {
    const state = await readRunnerState(root);
    await writeFile(runnerStatePath(root), JSON.stringify({ ...state, protocolVersion: PROTOCOL_VERSION + 1 }));
    const snapshot = await coordinator.snapshot();
    assert.equal(snapshot.runner.attached, true);
    assert.equal(snapshot.runner.compatible, false);
    assert.throws(() => coordinator.stop(), e => e.status === 409 && e.message === "incompatible-runner");
  } finally {
    killQuietly(runner.pid);
    await cleanup(root, coordinator);
  }
});

async function gitFixture() {
  const dir = await mkdtemp(join(tmpdir(), "soxu-update-git-"));
  const remote = join(dir, "remote.git"), seed = join(dir, "seed"), tool = join(dir, "tool");
  const git = (cwd, ...args) => run("git", args, { cwd, timeout: 30000 });
  const commit = (cwd, message) => git(cwd, "-c", "user.name=T", "-c", "user.email=t@example.org", "commit", "-m", message);
  await git(dir, "init", "--bare", "--initial-branch=main", remote);
  await git(dir, "clone", remote, seed);
  await writeFile(join(seed, "README.md"), "v1\n");
  await git(seed, "add", ".");
  await commit(seed, "🔧 chore(repo): init");
  await git(seed, "push", "origin", "main");
  await git(dir, "clone", remote, tool);
  await writeFile(join(seed, "README.md"), "v2\n");
  await git(seed, "add", ".");
  await commit(seed, "🐛 fix(repo): upstream change");
  await git(seed, "push", "origin", "main");
  return { dir, remote, seed, tool, git };
}

test("hot update fast-forwards the checkout and reports that a restart is required", async () => {
  const fixture = await gitFixture();
  try {
    const before = await checkUpdate({ toolRoot: fixture.tool });
    assert.equal(before.status, "ok");
    assert.equal(before.available, true);
    assert.equal(before.behind, 1);
    assert.equal(before.dirty, false);

    const result = await applyUpdate({ toolRoot: fixture.tool, smoke: async () => {} });
    assert.equal(result.status, "updated");
    assert.equal(result.restartRequired, true);
    assert.notEqual(result.previous, result.current);
    assert.equal((await readFile(join(fixture.tool, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "v2\n");

    // Nothing left to apply.
    const current = await applyUpdate({ toolRoot: fixture.tool, smoke: async () => {} });
    assert.equal(current.status, "up-to-date");
  } finally { await rm(fixture.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("hot update refuses a dirty checkout and rolls back a failed smoke check", async () => {
  const fixture = await gitFixture();
  try {
    const head = (await fixture.git(fixture.tool, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(fixture.tool, "README.md"), "local edit\n");
    await assert.rejects(() => applyUpdate({ toolRoot: fixture.tool, smoke: async () => {} }), e => e.status === 409 && e.message === "tool-repo-dirty");
    await fixture.git(fixture.tool, "checkout", "--", "README.md");

    const rolled = await applyUpdate({ toolRoot: fixture.tool, smoke: async () => { throw new Error("smoke failed"); } });
    assert.equal(rolled.status, "rolled-back");
    assert.equal(rolled.previous, head);
    assert.equal(rolled.current, head);
    assert.equal((await fixture.git(fixture.tool, "rev-parse", "HEAD")).stdout.trim(), head);
    assert.equal((await readFile(join(fixture.tool, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "v1\n");
  } finally { await rm(fixture.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

function call(port, { path, method = "GET", token = TOKEN, origin, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, method, path,
      headers: {
        ...(token ? { "X-SOXU-Control-Token": token } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      },
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? JSON.parse(text) : text });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("applying an update asks the caller to restart the dashboard", async () => {
  const root = await tempRoot("soxu-update-restart-");
  let restarts = 0;
  const coordinator = Object.assign(Object.create(DashboardCoordinator.prototype), {
    root, instanceId: "restart-test", lines: [], serial: 0,
    refreshUpdate: async () => ({ status: "ok", available: true, behind: 1 }),
    applyUpdate: async () => ({ status: "updated", previous: "11111111", current: "22222222", restartRequired: true }),
  });
  const { server, stopStreams } = createDashboardServer({
    root, token: TOKEN, coordinator,
    restart: async () => { restarts += 1; },
  });
  await new Promise(ok => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  const origin = "http://127.0.0.1:" + port;
  try {
    const result = await call(port, { path: "/api/update", method: "POST", origin, body: { action: "apply" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, "updated");
    assert.equal(result.body.restarting, true);
    await waitFor(() => restarts === 1, { label: "restart callback" });
  } finally {
    stopStreams();
    await new Promise(ok => server.close(ok));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("update endpoint enforces auth, origin and a strict action body", async () => {
  const root = await tempRoot("soxu-update-api-");
  const calls = [];
  const stub = Object.create(DashboardCoordinator.prototype);
  const coordinator = Object.assign(stub, {
    root, instanceId: "abc", lines: [], serial: 0,
    snapshot: async () => ({ ok: true }),
    refreshUpdate: async () => { calls.push("check"); return { status: "ok", available: false }; },
    applyUpdate: async () => { calls.push("apply"); return { status: "up-to-date" }; },
  });
  const { server, stopStreams } = createDashboardServer({ root, token: TOKEN, coordinator });
  await new Promise(ok => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  const origin = "http://127.0.0.1:" + port;
  try {
    assert.equal((await call(port, { path: "/api/update", method: "POST", token: null, origin, body: { action: "check" } })).status, 401);
    assert.equal((await call(port, { path: "/api/update", method: "POST", body: { action: "check" } })).status, 403);
    assert.equal((await call(port, { path: "/api/update", method: "POST", origin, body: { action: "rm" } })).status, 400);
    assert.equal((await call(port, { path: "/api/update", method: "POST", origin, body: { action: "check", extra: 1 } })).status, 400);
    const checked = await call(port, { path: "/api/update", method: "POST", origin, body: { action: "check" } });
    assert.equal(checked.status, 200);
    const applied = await call(port, { path: "/api/update", method: "POST", origin, body: { action: "apply" } });
    assert.equal(applied.status, 200);
    assert.deepEqual(calls, ["check", "apply"]);
  } finally {
    stopStreams();
    await new Promise(ok => server.close(ok));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
