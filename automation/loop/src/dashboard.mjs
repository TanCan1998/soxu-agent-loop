import { dataRoot } from "./config.mjs";
import { createServer } from "node:http";
import { fork } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ROOT, TOOL_ROOT } from "./config.mjs";
import { readCheckpoint } from "./checkpoint.mjs";
import { localProgress } from "./status.mjs";
import { safeActivity } from "./dashboard-activity.mjs";
import { readModelSettings, saveModelSettings, getPiModels } from "./model-settings.mjs";
import { loadRoleModels } from "./agent-models.mjs";
import { AdvisoryManager, readLatestReport, listReports, readReport, deleteReports } from "./dashboard-advisory.mjs";
import { readLaneStatus } from "./dashboard-lanes.mjs";
import { IntakeManager } from "./dashboard-intake.mjs";
import { cleanupMergedTasks } from "./merged-cleanup.mjs";
import { DraftStore } from "./dashboard-drafts.mjs";
import { mergeTaskPr } from "./dashboard-merge.mjs";
import { readGithubStatus } from "./dashboard-github.mjs";
import { isModelIdentifier } from "./model-identifiers.mjs";
import { stat, open } from "node:fs/promises";
import { spawn as spawnProcess } from "node:child_process";
import {
  PROTOCOL_VERSION, pidAlive, readRunnerState, readRunnerExit, clearRunnerState,
  runnerCompatible, writeRunnerState, runnerLogPath,
} from "./runner-state.mjs";
import { checkUpdate, applyUpdate as applyToolUpdate } from "./update.mjs";

export const DASHBOARD_PORT = 47321;
const COMMANDS = new Set(["once", "resume", "loop", "watch"]);
const GROUPS = ["running", "paused", "blocked", "pending", "done"];
const MAX_LOGS = 500;
const MAX_STREAM_CLIENTS = 8;
const PHASES = new Set(["worktree", "install", "develop", "checks", "review", "postConflictInstall", "recoveryInstall", "finalChecks", "commit", "push", "createPr", "merge", "done"]);
const WEB_DIR = join(TOOL_ROOT, "automation", "loop", "web");
const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

export function dashboardToken() { return randomBytes(24).toString("hex"); }
function tokenMatches(header, expected) {
  if (typeof header !== "string" || !/^[0-9a-f]{48}$/i.test(header)) return false;
  const a = Buffer.from(header, "hex"), b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
function cleanLine(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|authorization|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, 400);
}
async function liveExternalLocks(root) {
  const dir = join(root, ".soxu", "locks");
  let files;
  try { files = await readdir(dir); }
  catch (e) { if (e.code === "ENOENT") return 0; throw e; }
  let running = 0;
  for (const file of files.filter(x => /^(?:github|local)-issue-\d+\.lock$/.test(x))) {
    try {
      const lock = JSON.parse(await readFile(join(dir, file), "utf8"));
      if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) { running++; continue; }
      try { process.kill(lock.pid, 0); running++; }
      catch (e) { if (e.code !== "ESRCH") running++; }
    } catch (e) { if (e.code !== "ENOENT") running++; }
  }
  return running;
}

/** Owns only jobs explicitly launched from this web process. It cannot seize external Pi processes. */
export class DashboardCoordinator extends EventEmitter {
  constructor({ root = ROOT, spawn = fork, githubStatus = readGithubStatus, mergePr = mergeTaskPr, intake = null, advisory = null } = {}) {
    super();
    this.root = root;
    this.spawn = spawn;
    this.active = null;
    this.reserved = false;
    this.lastRun = null;
    this.lines = [];
    this.serial = 0;
    this.instanceId = randomBytes(8).toString("hex");
    this.agents = new Map();
    this.phases = new Map();
    this.taskModels = new Map();
    this.githubStatus = githubStatus;
    this.mergePr = mergePr;
    this.autoMergeEnabled = false;
    this.advisory = advisory ?? new AdvisoryManager({root,onChange:()=>{this.lanesNext=0;this.emit("dashboard:event",{type:"status",data:{}});}});
    this.drafts = new DraftStore({root,onChange:()=>this.emit("dashboard:event", {type:"status",data:{}})});
    this.intake = intake ?? new IntakeManager({root, onChange:()=>this.emit("dashboard:event", {type:"status",data:{}})});
    this.github = {status:"loading", updatedAt:null, tasks:{}};
    this.githubNext = 0;
    this.githubPending = null;
    this.lanes = null; this.lanesNext = 0; this.lanesPending = null;
    this.cleanupNext=0;this.cleanupPending=null;this.cleanupController=new AbortController();
    // A runner started by a previous dashboard survives a hot update; adopt it instead
    // of pretending the project is idle or spawning a second runner.
    this.attached = null;
    this.attachedOffset = 0;
    this.attachedTimer = null;
    this.updateInfo = null;
    this.updateCheckedAt = 0;
    this.stopped = false;
  }

  /** Read new bytes from the detached runner's durable log. */
  async catchUpRunnerLog() {
    const job = this.attached;
    if (!job?.logPath) return;
    try {
      const size = (await stat(job.logPath)).size;
      if (size <= this.attachedOffset) return;
      const start = Math.max(this.attachedOffset, size - 200_000);
      const handle = await open(job.logPath, "r");
      let text;
      try {
        const buffer = Buffer.alloc(size - start);
        await handle.read(buffer, 0, buffer.length, start);
        text = buffer.toString("utf8");
      } finally { await handle.close(); }
      this.attachedOffset = size;
      for (const line of text.split(/\r?\n/)) if (line.trim()) this.push(line, "runner");
    } catch { /* A missing log only means no new output. */ }
  }

  /** Adopt a runner left behind by a previous dashboard process. */
  async syncRunner() {
    if (this.active) return null;
    if (this.attached) {
      if (pidAlive(this.attached.pid)) { await this.catchUpRunnerLog(); return this.attached; }
      await this.finishAttached();
      return null;
    }
    const state = await readRunnerState(this.root);
    if (!state || state.invalid || !pidAlive(state.pid)) return null;
    this.attached = {
      command: state.command,
      pid: state.pid,
      startedAt: state.startedAt,
      logPath: state.logPath ?? runnerLogPath(this.root, state.pid),
      protocolVersion: state.protocolVersion,
      toolVersion: state.toolVersion,
      compatible: runnerCompatible(state),
      stopping: false,
    };
    this.attachedOffset = 0;
    this.push(`Attached to running ${state.command} (pid ${state.pid})${this.attached.compatible ? "" : "; protocol mismatch, control disabled"}`);
    await this.catchUpRunnerLog();
    this.attachedTimer ??= setInterval(() => { this.catchUpRunnerLog().catch(() => {}); }, 1000);
    this.attachedTimer.unref?.();
    this.emit("dashboard:event", { type: "status", data: {} });
    return this.attached;
  }

  async finishAttached(reason) {
    const job = this.attached;
    if (!job) return;
    if (this.attachedTimer) { clearInterval(this.attachedTimer); this.attachedTimer = null; }
    await this.catchUpRunnerLog();
    const exit = await readRunnerExit(this.root).catch(() => null);
    this.attached = null;
    await clearRunnerState(job.pid, this.root).catch(() => {});
    this.lastRun = {
      command: job.command,
      finishedAt: exit?.finishedAt ?? new Date().toISOString(),
      exitCode: Number.isInteger(exit?.exitCode) ? exit.exitCode : null,
      signal: exit?.signal ?? null,
      attached: true,
      reason: reason ?? null,
    };
    this.push(`Runner ${job.command} (pid ${job.pid}) finished${this.lastRun.exitCode === null ? "" : `; exit=${this.lastRun.exitCode}`}`);
    this.emit("dashboard:event", { type: "status", data: {} });
  }

  /** Stop a runner that this dashboard did not spawn (no IPC channel exists). */
  stopAttached() {
    const job = this.attached;
    if (!job) throw Object.assign(new Error("no-dashboard-job"), { status: 409 });
    if (!job.compatible) throw Object.assign(new Error("incompatible-runner"), { status: 409 });
    if (job.stopping) return { accepted: true, stopping: true };
    job.stopping = true;
    try {
      if (process.platform === "win32") spawnProcess("taskkill", ["/PID", String(job.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
      else { try { process.kill(-job.pid, "SIGTERM"); } catch { process.kill(job.pid, "SIGTERM"); } }
    } catch (e) {
      job.stopping = false;
      throw Object.assign(new Error("stop-failed"), { status: 409, cause: e });
    }
    this.push(`Stop requested for attached ${job.command} (pid ${job.pid})`);
    this.emit("dashboard:event", { type: "status", data: {} });
    return { accepted: true, stopping: true };
  }

  /** Read-only hot-update check, cached briefly to keep status polling cheap. */
  async refreshUpdate({ force = false } = {}) {
    if (!force && this.updateInfo && Date.now() - this.updateCheckedAt < 60_000) return this.updateInfo;
    try { this.updateInfo = await checkUpdate({ toolRoot: TOOL_ROOT }); }
    catch (e) { this.updateInfo = { status: "error", error: String(e?.message ?? e).slice(0, 300) }; }
    this.updateCheckedAt = Date.now();
    this.emit("dashboard:event", { type: "status", data: {} });
    return this.updateInfo;
  }

  /**
   * Apply a hot update while tasks keep running: already-loaded modules stay in the
   * live runner, the checkout moves forward, and a failed smoke gate rolls back.
   */
  async applyUpdate() {
    if (this.reserved) throw Object.assign(new Error("runner-busy"), { status: 409 });
    this.reserved = true;
    try {
      const result = await applyToolUpdate({ toolRoot: TOOL_ROOT });
      this.updateInfo = { ...result, toolRoot: TOOL_ROOT, protocolVersion: PROTOCOL_VERSION, checkedAt: new Date().toISOString() };
      this.updateCheckedAt = Date.now();
      this.push(`Hot update: ${result.status}${result.error ? ` (${result.error})` : ""}`, result.status === "updated" ? "system" : "system");
      return result;
    } finally {
      this.reserved = false;
      this.emit("dashboard:event", { type: "status", data: {} });
    }
  }
  push(message, stream = "system") {
    const line = { seq: ++this.serial, time: new Date().toISOString(), stream, message: cleanLine(message) };
    this.lines.push(line);
    if (this.lines.length > MAX_LOGS) this.lines.splice(0, this.lines.length - MAX_LOGS);
    this.emit("dashboard:event", { type: "log", data: line });
  }
  receiveTelemetry(message) {
    if (!this.active || !message || typeof message !== "object") return;
    if (message.type === "soxu:activity") {
      const activity = safeActivity(message.data);
      if (!activity) return;
      const key = `${activity.taskId}:${activity.role}`;
      if (!this.agents.has(key) && this.agents.size >= 32) return;
      this.agents.set(key, activity);
      this.emit("dashboard:event", { type: "agent", data: activity });
    } else if (message.type === "soxu:model") {
      const {taskId,role,provider,model}=message.data ?? {};
      const valid=s=>s===null || isModelIdentifier(s);
      if (!Number.isSafeInteger(taskId) || taskId<1 || taskId>=1e9 || !["developer","reviewer"].includes(role) || !valid(provider) || !valid(model) || Boolean(provider)!==Boolean(model)) return;
      const key=`${taskId}:${role}`;if(!this.taskModels.has(key) && this.taskModels.size>=32)return;
      this.taskModels.set(key,{taskId,role,provider,model});
      this.emit("dashboard:event",{type:"status",data:{}});
    } else if (message.type === "soxu:phase") {
      const { taskId, phase, status } = message.data ?? {};
      if (!Number.isSafeInteger(taskId) || taskId <= 0 || taskId >= 1e9 ||
          !PHASES.has(phase) || !["running", "paused", "blocked", "done"].includes(status)) return;
      this.phases.set(taskId, { phase, status, at: new Date().toISOString() });
      if (this.phases.size > 32) this.phases.delete(this.phases.keys().next().value);
      this.emit("dashboard:event", { type: "status", data: {} });
    }
  }
  refreshGithub() {
    if (this.githubPending || Date.now() < this.githubNext) return;
    this.githubNext = Date.now() + 60000;
    this.githubPending = Promise.resolve().then(() => this.githubStatus(this.root)).then(tasks => {
      this.github = {status:"ok", updatedAt:new Date().toISOString(), tasks};
    }).catch(() => {
      this.github = {status:"unavailable", updatedAt:null, tasks:{}};
    }).finally(() => { this.githubPending = null; this.emit("dashboard:event", {type:"status",data:{}}); });
  }
  refreshLanes() {
    if (this.lanesPending || Date.now() < this.lanesNext) return;
    this.lanesNext = Date.now() + 30000;
    this.lanesPending = readLaneStatus(this.root).then(value=>{this.lanes=value;}).catch(()=>{this.lanes=null;})
      .finally(()=>{this.lanesPending=null;this.emit("dashboard:event",{type:"status",data:{}});});
  }
  refreshCleanup() {
    if(this.cleanupController.signal.aborted || this.cleanupPending || Date.now()<this.cleanupNext)return;
    this.cleanupNext=Date.now()+60000;
    this.cleanupPending=cleanupMergedTasks(this.root,{signal:this.cleanupController.signal,log:message=>this.push(message)}).catch(e=>this.push(`Merged cleanup unavailable: ${e.message}`)).finally(()=>{this.cleanupPending=null;});
  }
  async snapshot() {
    this.refreshCleanup();
    this.refreshGithub();
    this.refreshLanes();
    const attached = await this.syncRunner().catch(() => null);
    await this.intake.initialized;
    await this.drafts.initialized;
    const [progress, externalLocks, modelInfo] = await Promise.all([
      localProgress(this.root, id => readCheckpoint(id, join(dataRoot(this.root), "checkpoints"))),
      liveExternalLocks(this.root),
      Promise.all([readModelSettings(this.root),loadRoleModels(process.env,{root:this.root})]).then(([settings,selected])=>({status:"ok",settings,selected,envOverrides:{developer:Boolean(process.env.SOXU_DEVELOPER_PROVIDER || process.env.SOXU_DEVELOPER_MODEL),reviewer:Boolean(process.env.SOXU_REVIEWER_PROVIDER || process.env.SOXU_REVIEWER_MODEL)}})).catch(()=>({status:"unavailable"})),
    ]);
    // Checkpoints use GitHub issue numbers, which need not match TASK identifiers.
    const github = this.github.status === "ok" ? {
      ...this.github, tasks: {...this.github.tasks, __queue: await Promise.all((this.github.tasks.__queue ?? []).map(async item => {
        try {
          const state = await readCheckpoint(item.number, join(dataRoot(this.root), "checkpoints"), false);
          const valid = state && !state.local && state.issue?.number === item.number && ["running","paused","blocked","done"].includes(state.status);
          return {...item, checkpoint: valid ? {status:state.status, phase:PHASES.has(state.phase) ? state.phase : null} : null};
        } catch { return {...item, checkpointUnavailable:true}; }
      }))}
    } : this.github;
    return {
      schemaVersion: 2,
      instanceId: this.instanceId,
      agents: [...this.agents.values()],
      taskModels: [...this.taskModels.values()],
      taskPhases: this.active ? [...this.phases.entries()].map(([taskId,value])=>({taskId,phase:value.phase,status:value.status})) : [],
      modelInfo,
      generatedAt: new Date().toISOString(),
      source: "local-checkpoints",
      github,
      autoMergeEnabled: this.autoMergeEnabled,
      intake: this.intake.publicState(),
      drafts: this.drafts.state(),
      lanes: this.lanes,
      advisory: this.advisory.state(),
      isLive: false,
      tasks: GROUPS.flatMap(status => progress[status].map(item => ({
        id: item.id, title: cleanLine(item.title ?? item.name).slice(0, 160),
        status, phase: item.phase, updatedAt: item.updatedAt,
      }))),
      protocolVersion: PROTOCOL_VERSION,
      runner: this.active
        ? { command: this.active.command, startedAt: this.active.startedAt, stopping: this.active.stopping, pid: this.active.child?.pid ?? null, attached: false, compatible: true, protocolVersion: PROTOCOL_VERSION }
        : attached
          ? { command: attached.command, startedAt: attached.startedAt, pid: attached.pid, stopping: attached.stopping, attached: true, compatible: attached.compatible, protocolVersion: attached.protocolVersion, toolVersion: attached.toolVersion }
          : null,
      update: this.updateInfo,
      lastRun: this.lastRun,
      externalLocks,
      busy: this.reserved || this.active !== null || attached !== null || externalLocks > 0,
      log: this.lines.slice(-MAX_LOGS),
      note: "Task phase is a checkpoint, not proof of a live Pi process; controls affect only dashboard-launched jobs.",
    };
  }
  async start(command, issue = null) {
    if (!COMMANDS.has(command) && command !== "resume-blocked") throw Object.assign(new Error("unsupported-command"), { status: 400 });
    if (this.reserved || this.active) throw Object.assign(new Error("runner-busy"), { status: 409 });
    // A runner left by a previous dashboard still owns the worktrees.
    if (await this.syncRunner()) throw Object.assign(new Error("runner-busy"), { status: 409 });
    this.reserved = true; // reserve before awaiting disk I/O to reject simultaneous requests
    try {
      if (await liveExternalLocks(this.root)) throw Object.assign(new Error("external-runner-active"), { status: 409 });
      let args = [command];
      if (command === "resume-blocked") {
        if (!Number.isSafeInteger(issue) || issue <= 0 || issue >= 1e9) throw Object.assign(new Error("invalid-issue"), { status: 400 });
        const state = await readCheckpoint(issue, join(dataRoot(this.root), "checkpoints"));
        if (!state || state.status !== "blocked" || state.issue?.number !== issue || state.local === true)
          throw Object.assign(new Error("task-not-blocked"), { status: 409 });
        args = ["resume", "--blocked", "--issue", String(issue)];
      }
      const script = join(TOOL_ROOT, "automation", "loop", "src", "cli.mjs");
      // Detached so that restarting the dashboard (hot update) cannot kill a run.
      const child = this.spawn(script, args, {
        cwd: this.root,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          SOXU_PROJECT_ROOT: this.root,
          SOXU_DASHBOARD_AUTO_MERGE: this.autoMergeEnabled ? "1" : "0",
          SOXU_RUNNER_STATE: "1",
        },
      });
      // Record the runner before it self-registers, so an immediate restart still finds it.
      if (child.pid) {
        await writeRunnerState({ command: args.join(" "), pid: child.pid, logPath: runnerLogPath(this.root, child.pid) }, this.root).catch(() => {});
      }
      const job = { child, command, startedAt: new Date().toISOString(), stopping: false };
      this.active = job;
      this.agents.clear();
      this.phases.clear();
      this.taskModels.clear();
      child.on("message", data => { if (this.active === job) this.receiveTelemetry(data); });
      this.push(`Started ${command}${issue ? ` #${issue}` : ""} (dashboard-owned)`);
      this.emit("dashboard:event", { type: "status", data: {} });
      const attach = (stream, pipe) => {
        if (!pipe) return;
        let unfinished = "";
        pipe.on("data", chunk => {
          const lines = (unfinished + String(chunk).slice(-16384)).split(/\r?\n/);
          unfinished = lines.pop().slice(-600);
          for (const line of lines.slice(-120)) if (line.trim()) this.push(line, stream);
        });
        pipe.on("end", () => { if (unfinished.trim()) this.push(unfinished, stream); });
      };
      attach("stdout", child.stdout);
      attach("stderr", child.stderr);
      child.once("error", e => this.push(`Runner spawn failed: ${e.code ?? "unknown"}`, "system"));
      // Prefer actual runner exit; inherited descendants may delay close on Windows.
      let finalized = false;
      const finish = (code, signal) => {
        if (finalized) return;
        finalized = true;
        if (this.active === job) this.active = null;
        for (const [key, value] of this.agents) {
          if (value.state === "waiting" || value.state === "generating" || value.state === "tool") {
            const finalState = code === 0 ? "completed" : "failed";
            const closed = { ...value, state: finalState, tool: null, activitySince: new Date().toISOString() };
            this.agents.set(key, closed);
            this.emit("dashboard:event", { type: "agent", data: closed });
          }
        }
        this.emit("dashboard:event", { type: "status", data: {} });
        this.lastRun = { command, finishedAt: new Date().toISOString(), exitCode: Number.isInteger(code) ? code : null, signal: signal ?? null };
        this.push(`Finished ${command}; exit=${code ?? "signal"}`, "system");
      };
      child.once("exit", finish);
      child.once("close", finish);
      return { accepted: true, command };
    } finally {
      this.reserved = false;
    }
  }
  setAutoMerge(enabled) {
    if (typeof enabled !== "boolean") throw Object.assign(new Error("invalid-setting"), {status:400});
    if (this.reserved || this.active) throw Object.assign(new Error("runner-busy"), {status:409});
    this.autoMergeEnabled = enabled;
    this.push(`Dashboard automatic merge ${enabled ? "enabled" : "disabled"} for future runs`);
    this.emit("dashboard:event", {type:"status",data:{}});
    return {enabled};
  }
  async merge(issue, pr) {
    if (this.reserved || this.active) throw Object.assign(new Error("runner-busy"), {status:409});
    this.reserved = true;
    try {
      if (await liveExternalLocks(this.root)) throw Object.assign(new Error("external-runner-active"), {status:409});
      const found = Object.values(this.github.tasks).some(t => t.issue === issue && t.pr?.number === pr && t.pr.state === "open");
      if (this.github.status !== "ok" || !found) throw Object.assign(new Error("pr-not-listed"), {status:409});
      const result = await this.mergePr(this.root, issue, pr);
      this.push(`PR #${pr} merged; remote branch ${result.branchDeleted ? "deleted" : "not deleted"}`);
      this.cleanupNext=0;this.refreshCleanup();
      this.githubNext = 0; this.refreshGithub();
      return result;
    } finally { this.reserved = false; this.emit("dashboard:event", {type:"status",data:{}}); }
  }
  stop() {
    if (!this.active && this.attached) return this.stopAttached();
    const job = this.active;
    if (!job) throw Object.assign(new Error("no-dashboard-job"), { status: 409 });
    if (job.stopping) return { accepted: true, stopping: true };
    if (!job.child.connected) throw Object.assign(new Error("runner-ipc-unavailable"), { status: 409 });
    job.child.send({ type: "soxu:interrupt" });
    job.stopping = true;
    this.push(`Graceful stop requested for ${job.command}`);
    this.emit("dashboard:event", { type: "status", data: {} });
    return { accepted: true, stopping: true };
  }
  shutdown() {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanupController.abort();
    this.advisory.shutdown();
    this.intake.shutdown();
    this.drafts.shutdown();
    if (this.attachedTimer) { clearInterval(this.attachedTimer); this.attachedTimer = null; }
    // An attached runner was launched by a previous dashboard and must survive this
    // process: that is what makes a dashboard restart a hot update instead of an abort.
    if (this.active && !this.active.stopping) {
      try { this.stop(); } catch { this.push("Stop message failed; inspect child process before exit"); }
    }
  }
}

async function readBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk.toString("utf8");
    if (Buffer.byteLength(raw) > 40000) throw Object.assign(new Error("body-too-large"), { status: 413 });
  }
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error("invalid-json"), { status: 400 }); }
}

export function createDashboardServer({ root = ROOT, token, coordinator = new DashboardCoordinator({ root }) } = {}) {
  if (typeof token !== "string" || !/^[0-9a-f]{48}$/i.test(token)) throw new Error("Invalid dashboard token");
  const streamClients = new Set();
  let heartbeat = null, catalogPromise = null;
  const release = response => {
    streamClients.delete(response);
    if (streamClients.size === 0 && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  const sendFrame = (response, type, data) => {
    if (response.destroyed || response.writableEnded) return release(response);
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    try {
      if (!response.write(frame)) { // Drop a slow reader; never buffer unbounded event frames.
        release(response);
        response.destroy();
      }
    } catch {
      release(response);
      response.destroy();
    }
  };
  const onEvent = event => {
    for (const response of streamClients) sendFrame(response, event.type, event.data);
  };
  coordinator.on("dashboard:event", onEvent);
  const stopStreams = () => {
    for (const response of streamClients) response.end();
    streamClients.clear();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    coordinator.off("dashboard:event", onEvent);
  };
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const port = server.address()?.port;
    const origin = `http://127.0.0.1:${port}`;
    const reply = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const peer = request.socket.remoteAddress;
    if (request.headers.host !== `127.0.0.1:${port}` || (peer !== "127.0.0.1" && peer !== "::ffff:127.0.0.1")) {
      return reply(403, { error: "invalid-host" });
    }
    if (request.headers.origin && request.headers.origin !== origin) return reply(403, { error: "invalid-origin" });
    if (request.method === "GET" && request.url === "/favicon.ico") {
      response.writeHead(204);
      return response.end();
    }
    if (request.method === "GET" && ASSETS.has(request.url)) {
      const [filename, type] = ASSETS.get(request.url);
      try {
        response.writeHead(200, { "Content-Type": type });
        return response.end(await readFile(join(WEB_DIR, filename)));
      } catch { return reply(503, { error: "ui-unavailable" }); }
    }
    if (!tokenMatches(request.headers["x-soxu-control-token"], token)) return reply(401, { error: "unauthorized" });
    if (request.method === "GET" && request.url === "/api/events") {
      if (streamClients.size >= MAX_STREAM_CLIENTS) return reply(429, { error: "too-many-streams" });
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      streamClients.add(response);
      response.once("close", () => release(response));
      response.once("error", () => release(response));
      sendFrame(response, "hello", { instanceId: coordinator.instanceId });
      if (!heartbeat) {
        heartbeat = setInterval(() => {
          for (const client of streamClients) {
            if (client.destroyed || client.writableEnded || !client.write(": ping\n\n")) {
              release(client);
              client.destroy();
            }
          }
        }, 15000);
        heartbeat.unref?.();
      }
      return;
    }
    if (request.method === "GET" && ["/api/advisory-report?lane=product", "/api/advisory-report?lane=quality"].includes(request.url)) {
      try { return reply(200, {report:await readLatestReport(root, request.url.endsWith("product") ? "product" : "quality")}); }
      catch { return reply(503, {error:"report-unavailable"}); }
    }
    if (request.method === "GET" && request.url.startsWith("/api/advisory-reports?")) {
      try { const query=new URL(request.url,origin).searchParams, lane=query.get("lane"), name=query.get("name");
        if ([...query.keys()].some(k=>!['lane','name'].includes(k)) || query.getAll('lane').length!==1 || query.getAll('name').length>1) return reply(400,{error:"invalid-query"});
        return reply(200,name === null ? {reports:await listReports(root,lane)} : {report:await readReport(root,lane,name)});
      } catch(error) {return reply(error.status ?? 503,{error:error.status ? error.message : "report-unavailable"});}
    }
    if (request.method === "GET" && request.url === "/api/model-catalog") {
      try {
        catalogPromise ??= getPiModels(root).finally(()=>{catalogPromise=null;});
        return reply(200,await catalogPromise);
      } catch {return reply(503,{error:"model-list-unavailable"});}
    }
    if (request.method === "GET" && request.url === "/api/status") {
      try { return reply(200, await coordinator.snapshot()); }
      catch { return reply(503, { error: "status-unavailable" }); }
    }
    if (request.method === "POST" && ["/api/run", "/api/stop", "/api/merge", "/api/auto-merge", "/api/update", "/api/intake-assess", "/api/intake-submit", "/api/intake-clear", "/api/drafts-save", "/api/drafts-move", "/api/drafts-remove", "/api/drafts-assess", "/api/drafts-answer", "/api/drafts-batch", "/api/drafts-resolve", "/api/advisory-run", "/api/advisory-delete", "/api/model-settings"].includes(request.url)) {
      if (request.headers.origin !== origin || request.headers["content-type"] !== "application/json") {
        return reply(403, { error: "invalid-request-origin" });
      }
      try {
        const body = await readBody(request);
        if (request.url === "/api/model-settings") {
          try {const settings=await saveModelSettings(body,root);return reply(200,{settings});}
          catch(error){return reply(error.status ?? 400,{error:error.status ? error.message : "invalid-model-settings"});}
        }
        if (request.url === "/api/update") {
          if (!body || Object.keys(body).sort().join(",") !== "action" || !["check", "apply"].includes(body.action)) return reply(400, { error: "invalid-body" });
          if (body.action === "check") return reply(200, await coordinator.refreshUpdate({ force: true }));
          // Allowed while a runner is active: loaded modules keep running, only new
          // processes see the updated checkout.
          const result = await coordinator.applyUpdate();
          return reply(result.status === "updated" || result.status === "up-to-date" ? 200 : 409, result);
        }
        if (request.url === "/api/advisory-delete") {
          if (!body || Object.keys(body).sort().join(",") !== "lane,name" || typeof body.lane!=="string" || !(body.name===null || typeof body.name==="string")) return reply(400,{error:"invalid-body"});
          const result=await deleteReports(root,body.lane,body.name);
          coordinator.lanesNext=0; coordinator.emit("dashboard:event",{type:"status",data:{}});
          return reply(200,result);
        }
        if (request.url === "/api/advisory-run") {
          if (!body || Object.keys(body).join(",") !== "lane" || typeof body.lane !== "string") return reply(400,{error:"invalid-body"});
          return reply(202, coordinator.advisory.start(body.lane));
        }
        if (request.url.startsWith("/api/drafts-")) {
          if (!body || typeof body!=="object" || Array.isArray(body)) return reply(400,{error:"invalid-body"});
          const keys=Object.keys(body).sort().join(","); let result;
          if(request.url==="/api/drafts-save" && keys==="id,requirement") result=await coordinator.drafts.save(body);
          else if(request.url==="/api/drafts-move" && keys==="direction,id") result=await coordinator.drafts.move(body.id,body.direction);
          else if(request.url==="/api/drafts-remove" && keys==="id") result=await coordinator.drafts.remove(body.id);
          else if(request.url==="/api/drafts-assess" && keys==="id") result=await coordinator.drafts.evaluate(body.id);
          else if(request.url==="/api/drafts-answer" && keys==="answers,id,milestone,ready") result=await coordinator.drafts.answer(body.id,body.answers,body.ready,body.milestone);
          else if(request.url==="/api/drafts-batch" && keys==="ids") result=await coordinator.drafts.batch(body.ids);
          else if(request.url==="/api/drafts-resolve" && keys==="created,id,url") result=await coordinator.drafts.resolve(body.id,body.created,body.url);
          else return reply(400,{error:"invalid-body"});
          return reply(200,result);
        }
        if (request.url === "/api/intake-assess") {
          if (!body || Object.keys(body).join(",") !== "requirement") return reply(400,{error:"invalid-body"});
          return reply(202, await coordinator.intake.start(body.requirement));
        }
        if (request.url === "/api/intake-clear") {
          if (!body || Object.keys(body).join(",") !== "id" || typeof body.id !== "string") return reply(400,{error:"invalid-body"});
          return reply(200, await coordinator.intake.clearUnknown(body.id));
        }
        if (request.url === "/api/intake-submit") return reply(409,{error:"use-draft-confirmation"});
        if (request.url === "/api/run") {
          if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.command !== "string")
            return reply(400, { error: "invalid-command" });
          const keys = Object.keys(body);
          if (body.command === "resume-blocked") {
            if (keys.length !== 2 || !keys.includes("issue")) return reply(400, { error: "invalid-command" });
            return reply(202, await coordinator.start(body.command, body.issue));
          }
          if (keys.length !== 1) return reply(400, { error: "invalid-command" });
          return reply(202, await coordinator.start(body.command));
        }
        if (request.url === "/api/merge") {
          if (!body || Object.keys(body).sort().join(",") !== "issue,pr") return reply(400, {error:"invalid-body"});
          return reply(200, await coordinator.merge(body.issue, body.pr));
        }
        if (request.url === "/api/auto-merge") {
          if (!body || Object.keys(body).join(",") !== "enabled") return reply(400, {error:"invalid-body"});
          return reply(200, coordinator.setAutoMerge(body.enabled));
        }
        if (!body || typeof body !== "object" || Object.keys(body).length !== 0)
          return reply(400, { error: "invalid-body" });
        return reply(202, coordinator.stop());
      } catch (error) {
        return reply(error.status ?? 503, { error: error.status ? error.message : "operation-failed" });
      }
    }
    return reply(404, { error: "not-found" });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return { server, coordinator, stopStreams };
}
