/**
 * Dashboard 协调器：拥有由本 Web 进程启动的 Runner、聚合状态快照、转发遥测。
 *
 * 从 dashboard.mjs 拆出（2026-11-02）：HTTP 路由留在 dashboard.mjs，
 * 「谁来跑任务、状态怎么算」集中在这一层。测试从 ../src/dashboard.mjs 转 import 这里。
 */
import { fork, spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ROOT, TOOL_ROOT, integrationBase, dataRoot } from "./config.mjs";
import { readCheckpoint } from "./checkpoint.mjs";
import { localProgress } from "./status.mjs";
import { safeActivity } from "./dashboard-activity.mjs";
import { readModelSettings } from "./model-settings.mjs";
import { loadRoleModels } from "./agent-models.mjs";
import { AdvisoryManager } from "./dashboard-advisory.mjs";
import { readLaneStatus } from "./dashboard-lanes.mjs";
import { IntakeManager } from "./dashboard-intake.mjs";
import { cleanupMergedTasks } from "./merged-cleanup.mjs";
import { DraftStore } from "./dashboard-drafts.mjs";
import { mergeTaskPr } from "./dashboard-merge.mjs";
import { readGithubStatus } from "./dashboard-github.mjs";
import { isModelIdentifier } from "./model-identifiers.mjs";
import { PROTOCOL_VERSION, pidAlive, readRunnerState, readRunnerExit, clearRunnerState, runnerCompatible, writeRunnerState, runnerLogPath } from "./runner-state.mjs";
import { checkUpdate, applyUpdate as applyToolUpdate } from "./update.mjs";
import { publishStatus, publish as publishVersion } from "./publish.mjs";
import { writeQueueOrder, setIssueReady } from "./queue-order.mjs";
import { run } from "./process.mjs";
import { loadTaskCatalog } from "./task-catalog.mjs";
import { buildLocalRoadmap } from "./roadmap-local.mjs";
import { cleanLine, inspectExternalLocks } from "./dashboard-utils.mjs";

/** 一次 /api/run 允许的命令。 */
const COMMANDS = new Set(["start", "loop", "watch"]);
/** 快照里的任务分组顺序。 */
const GROUPS = ["running", "paused", "blocked", "pending", "done"];
/** 内存日志上限（条）。 */
const MAX_LOGS = 500;
/** checkpoint 里合法的 phase 名，快照透出前先过滤。 */
const PHASES = new Set(["worktree", "install", "develop", "checks", "review", "postConflictInstall", "recoveryInstall", "finalChecks", "commit", "push", "createPr", "merge", "done"]);

export class DashboardCoordinator extends EventEmitter {
  constructor({ root = ROOT, spawn = fork, githubStatus = readGithubStatus, mergePr = mergeTaskPr, intake = null, advisory = null, checkToolUpdate = checkUpdate } = {}) {
    super();
    this.root = root;
    this.spawn = spawn;
    this.active = null;
    this.reserved = false;
    this.lastRun = null;
    this.lines = [];
    // 日志回填只做一次：runner 输出原本只活在内存里，dashboard 重启后就查不到历史。
    this.logBackfillTried = false;
    this.serial = 0;
    this.instanceId = randomBytes(8).toString("hex");
    this.agents = new Map();
    this.phases = new Map();
    this.taskModels = new Map();
    this.githubStatus = githubStatus;
    this.mergePr = mergePr;
    // 自动合并默认开启：agent 合入集成分支（dev），main 只由人工发布写入。
    this.autoMergeEnabled = true;
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
    this.checkToolUpdate = checkToolUpdate;
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
    try { this.updateInfo = await this.checkToolUpdate({ toolRoot: TOOL_ROOT }); }
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
    this.applyingUpdate = true;
    try { return await this.#applyUpdate(); }
    finally { this.applyingUpdate = false; }
  }
  async #applyUpdate() {
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
  refreshGithub(force = false) {
    if (this.githubPending) return;
    if (!force && Date.now() < this.githubNext) return;
    this.githubNext = Date.now() + 60000;
    this.githubPending = Promise.resolve().then(async () => this.githubStatus(this.root, undefined, await integrationBase())).then(tasks => {
      this.github = {status:"ok", updatedAt:new Date().toISOString(), tasks};
    }).catch((error) => {
      // 过去这里静默吞掉错误，导致面板只显示「GitHub 不可用」而无从排查
      // （2026-10-30 实际是 TASK-032.md 的 frontmatter 少了闭合 ---）。
      this.push("GitHub status unavailable: " + String(error?.message ?? error).slice(0, 300), "system");
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
    this.cleanupPending=Promise.resolve(integrationBase()).then(base=>cleanupMergedTasks(this.root,{signal:this.cleanupController.signal,log:message=>this.push(message),base,deferWhenRunnerActive:true})).catch(e=>this.push(`Merged cleanup unavailable: ${e.message}`)).finally(()=>{this.cleanupPending=null;});
  }
  /**
   * 从 .soxu/runner 最新的日志文件回填一次日志。
   *
   * 历史缺陷：`log` 字段只有内存态，dashboard 因 hot update 重启后为空，
   * 排查"任务为什么失败"时无从下手（runner 日志其实一直在写文件）。
   */
  async backfillLogFromRunnerFile() {
    if (this.lines.length || this.logBackfillTried) return;
    this.logBackfillTried = true;
    try {
      const dir = join(this.root, ".soxu", "runner");
      const files = await readdir(dir).catch(() => []);
      const logs = [];
      for (const name of files) {
        if (!name.endsWith(".log")) continue;
        const info = await stat(join(dir, name)).catch(() => null);
        if (info) logs.push({ name, mtimeMs: info.mtimeMs });
      }
      if (!logs.length) return;
      logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const text = await readFile(join(dir, logs[0].name), "utf8").catch(() => "");
      const rows = text.split(/\r?\n/).filter(line => line.trim()).slice(-200);
      if (!rows.length) return;
      for (const line of rows) {
        this.lines.push({ seq: ++this.serial, time: null, stream: "runner", message: cleanLine(line) });
      }
      this.push(`(recovered ${rows.length} log lines from ${logs[0].name})`, "system");
    } catch { /* 回填失败不能影响状态接口 */ }
  }
  async snapshot() {
    await this.backfillLogFromRunnerFile();
    this.refreshCleanup();
    this.refreshGithub();
    this.refreshLanes();
    const attached = await this.syncRunner().catch(() => null);
    // 发布状态：dev 是否已合入 main、本地检出与版本；30 秒缓存，避免每次轮询都跑 git/gh。
    if (!this.publishInfo || Date.now() - (this.publishCheckedAt ?? 0) > 30_000) {
      this.publishCheckedAt = Date.now();
      this.publishInfo = await publishStatus().catch(error => ({ error: String(error?.message ?? error).slice(0, 200) }));
    }
    // Keep the update badge meaningful without a manual click; cached for 60s.
    void this.refreshUpdate().catch(() => {});
    await this.intake.initialized;
    await this.drafts.initialized;
    const [progress, externalLockInfo, modelInfo] = await Promise.all([
      localProgress(this.root, id => readCheckpoint(id, join(dataRoot(this.root), "checkpoints")),
        { checkpointDir: join(dataRoot(this.root), "checkpoints") }),
      inspectExternalLocks(this.root),
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
      // Milestone detail must not depend on GitHub: fall back to catalog + checkpoints.
      roadmap: this.github.status === "ok" && this.github.tasks?.__roadmap
        ? { ...this.github.tasks.__roadmap, source: "github" }
        : buildLocalRoadmap(await loadTaskCatalog(this.root).catch(() => []), progress),
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
      publish: this.publishInfo ?? null,
      lastRun: this.lastRun,
      externalLocks: externalLockInfo.active,
      externalLockStale: externalLockInfo.stale,
      externalLockDetails: externalLockInfo.locks,
      busy: this.reserved || this.active !== null || attached !== null || externalLockInfo.active > 0,
      log: this.lines.slice(-MAX_LOGS),
      note: "Task phase is a checkpoint, not proof of a live Pi process; controls affect only dashboard-launched jobs.",
    };
  }
  /** 看板上拖动排序：保存 issue 号顺序（影响展示顺序与 agent 认领顺序）。 */
  async reorderQueue(order) {
    if (!Array.isArray(order) || order.length > 1000) throw Object.assign(new Error("invalid-order"), { status: 400 });
    const saved = await writeQueueOrder(this.root, order);
    this.refreshGithub(true);
    await this.githubPending;
    return { order: saved };
  }
  /** 直接给已创建需求打/撤 agent:ready，打之前做依赖校验。 */
  async setQueueReady(number, ready) {
    try {
      const result = await setIssueReady(this.root, number, ready, { execute: run });
      if (result.ok) { this.refreshGithub(true); await this.githubPending; }
      return result;
    } catch (error) {
      // 把真实原因带回前端，比统一的 503 operation-failed 有用得多。
      const message = String(error?.message ?? error).slice(0, 300);
      console.error("queue-ready failed: " + message);
      return { ok: false, number, ready: false, missing: [], reason: "error", message };
    }
  }
  async start(command) {
    if (!COMMANDS.has(command)) throw Object.assign(new Error("unsupported-command"), { status: 400 });
    if (this.reserved || this.active) throw Object.assign(new Error("runner-busy"), { status: 409 });
    // A runner left by a previous dashboard still owns the worktrees.
    if (await this.syncRunner()) throw Object.assign(new Error("runner-busy"), { status: 409 });
    this.reserved = true; // reserve before awaiting disk I/O to reject simultaneous requests
    try {
      if ((await inspectExternalLocks(this.root)).active) throw Object.assign(new Error("external-runner-active"), { status: 409 });
      const args = [command];
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
      this.push(`Started ${command} (dashboard-owned)`);
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
  /** 发布 preview（dev 直接打预发布 tag）或 release（dev 已合入 main 后在 main 发布）。 */
  async publishVersion(mode) {
    if (this.reserved || this.active) throw Object.assign(new Error("runner-busy"), { status: 409 });
    this.reserved = true;
    try {
      // 外部 Runner 正在跑同一个 checkout 时发布，会和它的 git/tag 操作抢引用。
      if ((await inspectExternalLocks(this.root)).active) throw Object.assign(new Error("external-runner-active"), { status: 409 });
      const result = await publishVersion(mode);
      this.push(`Publish ${mode}: ${result.status} ${result.tag ?? ""}`.trim());
      this.publishCheckedAt = 0;
      return result;
    } finally { this.reserved = false; this.emit("dashboard:event", { type: "status", data: {} }); }
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
      if ((await inspectExternalLocks(this.root)).active) throw Object.assign(new Error("external-runner-active"), {status:409});
      const found = Object.values(this.github.tasks).some(t => t.issue === issue && t.pr?.number === pr && t.pr.state === "open");
      if (this.github.status !== "ok" || !found) throw Object.assign(new Error("pr-not-listed"), {status:409});
      const result = await this.mergePr(this.root, issue, pr, undefined, await integrationBase());
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
