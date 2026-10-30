#!/usr/bin/env node
import { ROOT, policy as loadPolicy, integrationBase } from "./config.mjs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { run, git } from "./process.mjs";
import { processIssue } from "./worker.mjs";
import { seedIssues, listIssues, processAuthorizedReleases } from "./github.mjs";
import { listPaused, readCheckpoint, writeCheckpoint } from "./checkpoint.mjs";
import { recoverFromSentence } from "./recovery.mjs";
import { interruptibleWait } from "./interruptible-wait.mjs";
import { loadRoleModels } from "./agent-models.mjs";
import { localProgress } from "./status.mjs";
import { prepareWorktreeRecovery } from "./worktree-sync.mjs";
import { localTasks as getLocalTasks } from "./local-queue.mjs";
import { cleanupMergedTasks } from "./merged-cleanup.mjs";
import { writeRunnerState, recordRunnerExitSync, runnerLogPath } from "./runner-state.mjs";
import { teeStdioToFile } from "./runner-log.mjs";
import { checkUpdate, applyUpdate } from "./update.mjs";
import { partitionRecoveryCandidates } from "./blocked-recovery.mjs";
import { safeFailureMessage } from "./errors.mjs";

// Register before any command runs: `start` is awaited at top level, so a hook at the
// bottom of the file would only run after the task finished and be useless for reattach.
if (process.env.SOXU_RUNNER_STATE === "1") {
  const runnerCommand = process.argv[2] || "doctor";
  const logPath = runnerLogPath(ROOT, process.pid);
  teeStdioToFile(logPath);
  await writeRunnerState({ command: runnerCommand, pid: process.pid, logPath }, ROOT);
  process.once("exit", code => {
    try { recordRunnerExitSync({ command: runnerCommand, pid: process.pid, exitCode: code }, ROOT); }
    catch { /* Never block teardown on bookkeeping. */ }
  });
}

const HELP = `SOXU Agent Loop

Usage:
  node automation/loop/src/cli.mjs [command] [options]

Commands:
  cleanup      Recheck merged Runner PRs and safely remove matching branches
  doctor       Check toolchain, model configuration and lockfiles (default)
  status       Show offline task status; add --json for machine-readable output
  models       Show Developer / Reviewer model routing
  seed-issues  Publish backlog tasks as GitHub Issues
  start        Recover paused/blocked tasks first, otherwise run the next batch
  loop         Run a bounded number of autonomous development rounds
  watch        Poll GitHub tasks (bounded by policy; no --local or --dry-run)
  say          Execute a natural-language recovery instruction
  update       Fast-forward the tool checkout (hot update); add --check to only compare
  help         Show this help

Options:
  -h, --help   Show this help (also works after a command)
  --local      Use local tasks where supported
  --github     Force GitHub mode for natural-language recovery
  --dry-run    Preview eligible tasks/recovery actions without executing them
  --json       JSON output for status
  --blocked    Explicitly include blocked tasks in resume (inspect and fix cause first)

Examples:
  node automation/loop/src/cli.mjs status
  node automation/loop/src/cli.mjs status --json
  node automation/loop/src/cli.mjs once --local --dry-run
  node automation/loop/src/cli.mjs resume --issue 123
  node automation/loop/src/cli.mjs say --local "继续 SOXU"
`;

const [command = "doctor", ...args] = process.argv.slice(2).filter(x => x !== "--");
if (command === "help" || command === "-h" || command === "--help" || args.includes("-h") || args.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}
const local = args.includes("--local"), githubOnly = args.includes("--github"), dryRun = args.includes("--dry-run");
if (local && githubOnly) throw new Error("--local and --github cannot be combined");
const p = await loadPolicy();
// Only a dashboard-owned child receives an explicit, session-scoped override.
if (typeof process.send === "function" && ["0", "1"].includes(process.env.SOXU_DASHBOARD_AUTO_MERGE))
  p.autoMerge = process.env.SOXU_DASHBOARD_AUTO_MERGE === "1";

function naturalSentence() {
  const ignored = new Set(["--dry-run", "--local", "--github"]);
  return args.filter(x => !ignored.has(x)).join(" ").trim();
}
const controller = new AbortController();
for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => {
  if (controller.signal.aborted) { console.error("Second interrupt: forced exit; resume from checkpoint later."); process.exit(130); }
  console.error("Stopping active Pi and check processes; saving recoverable checkpoint...");
  controller.abort();
});

// Dashboard-owned jobs accept an IPC stop request from the parent process.
// On Windows this avoids forcefully killing Node before it can preserve checkpoints.
if (typeof process.send === "function") process.on("message", message => {
  if (message?.type === "soxu:interrupt" && !controller.signal.aborted) {
    console.error("Dashboard stop requested; aborting running checks and Pi subprocesses...");
    controller.abort();
  }
});

// Do not let a registered IPC listener keep an otherwise finished child alive.
if (typeof process.send === "function") process.channel?.unref?.();

async function verifyLockfiles() {
  const missing = [];
  for (const name of ["pnpm-lock.yaml", "Cargo.lock"]) {
    try { await access(join(ROOT, name)); }
    catch (err) { if (err.code === "ENOENT") missing.push(name); else throw err; }
  }
  if (missing.length) throw new Error(`Bootstrap lockfiles missing (${missing.join(", ")}); run pnpm install --lockfile-only and cargo generate-lockfile in project root, commit lockfiles before paid Agent runs.`);
}
async function issues() {
  if (local) {
    const {ready, waiting} = await getLocalTasks(undefined, await integrationBase());
    if (waiting.length) console.log(`Local prerequisites pending integration into main: ${waiting.map(t => `${t.id} <- ${t.missing.join(',')}`).join('; ')}`);
    return ready;
  }
  // 必须传集成分支：listIssues 的 base 默认是 "main"，而 SOXU 用 dev 作集成分支。
  // 不传的话 mergedIssueNumbers(prs, "main") 永远查不到合并到 dev 的 PR，
  // 依赖转换（waiting → ready）会全部失效（2026-10-29 实测）。
  return listIssues({ promote: !dryRun, base: await integrationBase() });
}
async function doctor() {
  console.log("SOXU Agent Loop doctor\nProject:", ROOT);
  for (const [bin, argv] of [["node", ["--version"]], ["git", ["--version"]], ["pnpm", ["--version"]], ["cargo", ["--version"]], ["gh", ["--version"]], ["pi", ["--help"]]]) {
    try { const out = await run(bin, argv, { cwd: ROOT, timeoutMs: 10000 }); console.log(`  OK ${bin}: ${out.stdout.slice(0,90).replaceAll("\n"," ")}`); }
    catch (e) { console.log(`  MISSING ${bin}: ${e.message.slice(0,180)}`); }
  }
  try { console.log("  git branch:", await git(["branch", "--show-current"], ROOT)); }
  catch { console.log("  Git uninitialized: run node scripts/init-git.mjs"); }
  console.log("  agent models:", JSON.stringify(await loadRoleModels()));
  try { await verifyLockfiles(); console.log("  lockfiles: present"); }
  catch (e) { console.log("  lockfiles: NOT READY —", e.message); }
  console.log("  policy:", JSON.stringify({ maxConcurrentAgents:p.maxConcurrentAgents, timeouts:p.timeouts, autoMerge:p.autoMerge, autoRelease:p.autoRelease }));
  console.log("  paused or interrupted tasks:", (await listPaused()).map(x => `#${x.issue.number} (${x.status}: ${x.phase})`).join(", ") || "none");
}
async function cleanup() { try { return await cleanupMergedTasks(ROOT,{signal:controller.signal, base: await integrationBase()}); } catch { console.warn("Merged cleanup unavailable; retry on the next run."); return [{status:"error"}]; } }

/**
 * 清理脏状态：runner 被强制终止（kill -9、断电、面板强制关闭）时，
 * checkpoint 会停在 status=running，但实际没有进程在跑。
 * 后果是面板显示"执行中"、任务却永远不会推进，只能人工改 JSON。
 *
 * 判断依据：本进程正在启动（说明之前的 runner 已经退出），
 * 此时任何 running 的 checkpoint 都是脏的。
 */
async function clearStaleRunning() {
  let candidates;
  try { candidates = await listPaused(undefined, { includeBlocked: true }); }
  catch { return; }
  for (const state of candidates) {
    if (state.status !== "running") continue;
    const previousPhase = state.phase ?? "unknown";
    state.status = "paused";
    state.reason = "stale-running";
    state.lastError = "checkpoint 停在 running 但没有活跃 runner（进程被强制终止）；启动时自动改为 paused，可安全恢复";
    try {
      await writeCheckpoint(state);
      console.log(`Cleared stale running state for #${state.issue?.number ?? "?"} (phase ${previousPhase})`);
    } catch (error) {
      console.warn(`Unable to clear stale running state for #${state.issue?.number ?? "?"}: ${safeFailureMessage(error, 200)}`);
    }
  }
}
async function once() {
  if (!local && !dryRun) await cleanup();
  if (!dryRun) await verifyLockfiles();
  const available = await issues();
  // Callers report the outcome once; printing here duplicated start()'s message.
  if (!available.length) return [];
  if (dryRun) { for (const issue of available.slice(0, p.maxConcurrentAgents)) console.log(`would run #${issue.number}: ${issue.title}`); return []; }
  return Promise.all(available.slice(0, p.maxConcurrentAgents).map(issue => processIssue(issue, { policy: p, local, signal: controller.signal })));
}
/** One finite recovery batch: paused and blocked tasks are handled uniformly. */
/**
 * 恢复暂停/阻塞任务。
 *
 * includeBlocked 默认 true（`start` 命令 = 人工显式恢复）；
 * `loop` 启动时的自动恢复传 false，只恢复被中断的 paused，不替用户解锁 blocked。
 */
async function recover(selected = null, { includeBlocked = true } = {}) {
  const candidates = selected ?? (await listPaused(undefined, { includeBlocked })).filter(s => local ? s.local : !s.local);
  if (!candidates.length) { console.log("No recoverable task; nothing to replay or bill."); return; }
  const select = selected ? null : args.find(x => /^#?\d+$/.test(x));
  const tasks = selected ?? (select ? candidates.filter(s => s.issue.number === Number(select.replace("#", ""))) : candidates);
  if (!tasks.length) throw new Error(`No saved task matches ${select}`);
  if (dryRun) { for (const s of tasks) console.log(`would recover #${s.issue.number} at ${s.phase} (${s.status}: ${s.reason ?? "interrupted"})`); return; }
  // Safely preserve dirty edits and let Developer reconcile any main conflicts.
  // Never request paid Pi calls for unsafe/missing worktrees.
  // 恢复路径也必须按集成分支同步工作树，否则会把任务基点拉到 main。
  const { eligible, blocked } = await prepareWorktreeRecovery(tasks, { base: await integrationBase() });
  if (blocked.length) process.exitCode = 1;
  // Manual resume is intentionally one finite batch, not an endless retry loop.
  for (let i = 0; i < eligible.length; i += p.maxConcurrentAgents) {
    const results = await Promise.all(eligible.slice(i, i + p.maxConcurrentAgents).map(s => processIssue(s.issue, { policy: p, local, resume: true, allowBlocked: includeBlocked, signal: controller.signal })));
    if (results.some(x => x.status === "paused" || x.status === "blocked")) {
      console.log("Recovery paused/blocked again; no automatic API retry. Inspect the failure and start again when resolved.");
      process.exitCode = 1;
      break;
    }
  }
}
const problematic = results => results.some(x => x.status === "paused" || x.status === "blocked");
/**
 * The single dashboard/CLI entry point: recover first, otherwise run the next
 * batch. Both paths stay in one subprocess so two runners never race worktrees.
 */
async function start() {
  if (!dryRun) await clearStaleRunning();
  const candidates = (await listPaused(undefined, { includeBlocked: true })).filter(s => local ? s.local : !s.local);
  // blocked 任务自动重试，但有界：超过上限就不再抢占队列，新任务可以继续。
  const { actionable, exhausted } = partitionRecoveryCandidates(candidates, p.maxBlockedRecoveries ?? 2);
  for (const task of exhausted) console.log(`Skipping #${task.issue.number}: blocked ${task.blockedRecoveryCount} time(s) without progress; needs manual inspection.`);
  if (dryRun) {
    if (actionable.length) { await recover(actionable); return; }
    const available = await issues();
    if (!available.length) { console.log("No recoverable or eligible task; nothing would run."); return; }
    for (const issue of available.slice(0, p.maxConcurrentAgents)) console.log(`would run #${issue.number}: ${issue.title}`);
    return;
  }
  if (actionable.length) {
    if (!local) await cleanup();
    await recover(actionable);
    if (!local) await cleanup();
    return;
  }
  const results = await once();
  if (!results.length && !dryRun) console.log("No recoverable or eligible task; nothing to do.");
  if (!local) { await cleanup(); if (!problematic(results)) await processAuthorizedReleases(p); }
  if (problematic(results)) process.exitCode = 1;
}
switch (command) {
  case "cleanup": { if(local || dryRun) throw new Error("cleanup requires GitHub mode"); const results=await cleanup();
    const count = s => results.filter(x=>x.status===s).length;
    console.log(`Merged cleanup: ${count("cleaned")} cleaned, ${count("preserved")} preserved, ${count("not-verified")} unverified, ${results.filter(x=>["error","invalid-checkpoint"].includes(x.status)).length} errors; unmerged, unverified or locked tasks are retained.`);
    for (const row of results.filter(x=>x.status==="not-verified")) {
      const why = row.reason === "head-changed"
        ? "PR head 与任务提交不一致（分支在任务后又被推送过），保留 worktree 待人工核实"
        : "PR 未合并或目标分支不符";
      console.log(`  #${row.issue} 未核实：${why}`);
    }
    if(results.some(x=>["error","invalid-checkpoint"].includes(x.status))) process.exitCode=1; break; }
  case "doctor": await doctor(); break;
  case "status": {
    const snapshot = await localProgress(ROOT, id => readCheckpoint(id, undefined, local));
    if (args.includes('--json')) console.log(JSON.stringify(snapshot,null,2));
    else {
      // Both modes list the same task files but read different checkpoint namespaces,
      // so say which one is shown or finished GitHub tasks look unstarted.
      console.log(`SOXU offline task status in ${local ? 'local-queue' : 'GitHub-issue'} mode (not live GitHub or PiDeck data)`);
      for (const group of ['done','running','paused','blocked','pending']) {
        console.log(`  ${group}: ${snapshot[group].length}`);
        for (const item of snapshot[group]) console.log(`    #${item.id} ${item.title ?? item.name}${item.phase ? ` [${item.phase}]` : ''}${item.updatedAt ? ` (${item.updatedAt})` : ''}`);
      }
      console.log('  For GitHub: gh issue list; gh pr list; gh run list --limit 10');
    }
    break;
  }
  case "update": {
    if (args.includes("--check") || dryRun) {
      const check = await checkUpdate();
      if (args.includes("--json")) { console.log(JSON.stringify(check, null, 2)); break; }
      console.log("Tool checkout: " + (check.branch ?? "?") + " @ " + String(check.current ?? "?").slice(0, 8));
      console.log("Upstream: " + (check.upstream ?? "none") + "  ahead=" + (check.ahead ?? "?") + " behind=" + (check.behind ?? "?"));
      console.log("Working tree: " + (check.dirty === null ? "unknown" : check.dirty ? "dirty (apply refuses)" : "clean"));
      console.log("Status: " + check.status + (check.error ? " (" + check.error + ")" : ""));
      console.log(check.available ? "Update available: run without --check to fast-forward." : "Already current with upstream.");
      break;
    }
    const result = await applyUpdate();
    if (args.includes("--json")) { console.log(JSON.stringify(result, null, 2)); break; }
    console.log("Hot update: " + result.status + " (" + String(result.previous ?? "?").slice(0, 8) + " -> " + String(result.current ?? "?").slice(0, 8) + ")");
    if (result.error) console.log("Reason: " + result.error);
    if (result.note) console.log(result.note);
    if (result.status !== "updated" && result.status !== "up-to-date") process.exitCode = 1;
    break;
  }
  case "models": {
    const selections = await loadRoleModels();
    console.log("SOXU Pi model routing (no API credentials):");
    for (const [role, choice] of Object.entries(selections)) {
      console.log(`  ${role}: ${choice.provider ? `${choice.provider}/${choice.model}` : "inherit Pi session/project/global model"}; thinking=${choice.thinking ?? "inherit"}`);
    }
    break;
  }
  case "seed-issues": await seedIssues(); break;
  case "start": await start(); break;
  case "say": {
    const sentence = naturalSentence();
    if (!sentence) throw new Error('请提供一句话，例如：pnpm agent:say -- "继续 SOXU"');
    const results = await recoverFromSentence(sentence, { policy: p, localOnly: local, githubOnly, dryRun, signal: controller.signal });
    if (problematic(results)) process.exitCode = 1;
    if (!local && !dryRun) await cleanup();
    break;
  }
  case "watch": {
    if (local || dryRun) throw new Error("watch requires GitHub mode and cannot be dry-run");
    await verifyLockfiles();
    const stopAt = Date.now() + p.maxContinuousHours * 3600000;
    let handled = 0;
    console.log(`Watch enabled for at most ${p.maxContinuousHours}h, max ${p.maxIssuesPerWatch} attempted issues`);
    while (!controller.signal.aborted && Date.now() < stopAt && handled < p.maxIssuesPerWatch) {
      await cleanup();
      const before = await issues();
      const batch = before.slice(0, Math.min(p.maxConcurrentAgents, p.maxIssuesPerWatch - handled));
      if (batch.length) {
        handled += batch.length;
        const results = await Promise.all(batch.map(x => processIssue(x, { policy: p, signal: controller.signal })));
        if (problematic(results)) { console.error("Task paused or blocked; ending watch until explicit manual resume"); process.exitCode = 1; break; }
      }
      if (controller.signal.aborted) break;
      await cleanup();
      await processAuthorizedReleases(p);
      if (Date.now() >= stopAt || handled >= p.maxIssuesPerWatch) break;
      const nextPoll=Math.min(stopAt,Date.now()+p.watchIntervalMinutes*60000);
      while(!controller.signal.aborted && Date.now()<nextPoll) {
        if(!await interruptibleWait(Math.min(60000,nextPoll-Date.now()),controller.signal)) break;
        if(!controller.signal.aborted) await cleanup();
      }
    }
    break;
  }
  case "loop": {
    if (!dryRun) await verifyLockfiles();
    // 启动即代表上一个 runner 已退出：残留的 running 状态都是脏的。
    if (!dryRun) await clearStaleRunning();
    if (!local && !dryRun) await cleanup();
    // 被中断的任务是 agent:paused，不在 ready 队列里；不先恢复的话，
    // 面板上的「运行」永远推不动它们（历史缺陷：面板显示运行中，实际全卡 paused）。
    if (!dryRun) {
      const interrupted = (await listPaused(undefined, { includeBlocked: false })).filter(s => local ? s.local : !s.local);
      if (interrupted.length) {
        console.log("Resuming " + interrupted.length + " interrupted task(s) before the loop");
        // 只恢复 paused：blocked 需要人工确认原因后再用 start 解锁（P0-3）。
        await recover(null, { includeBlocked: false });
        if (controller.signal.aborted) break;
      }
    }
    for (let round = 0; round < p.maxRoundsPerInvocation; round++) {
      console.log(`SOXU loop round ${round + 1}/${p.maxRoundsPerInvocation}`);
      const available = await issues();
      if (!available.length) {
        console.log("No more ready issues");
        // 队列空了也要收尾：本轮 PR 可能刚被 auto-merge 合并，需要关 Issue、清 worktree。
        if (!local && !dryRun) { await cleanup(); await processAuthorizedReleases(p); }
        break;
      }
      const results = await once();
      // 收尾必须在本轮任何分支之前执行：历史缺陷是 problematic 分支直接 break，
      // 跳过 cleanup，导致已合并的 issue 一直挂着 agent:pr 永不关闭。
      if (!local && !dryRun) await cleanup();
      if (problematic(results)) { process.exitCode = 1; console.log("Task paused/blocked; manual resume required. Stop to avoid wasting quota."); break; }
      if (!local && !dryRun) await processAuthorizedReleases(p);
      if (dryRun) break;
    }
    // 兜底：循环因中断/异常退出时再收一次，保证已完成任务的 issue/worktree 不残留。
    if (!local && !dryRun) { try { await cleanup(); } catch (error) { console.warn("cleanup after loop failed: " + safeFailureMessage(error, 200)); } }
    break;
  }
  default: throw new Error(`Unknown command '${command}', expected doctor|status|models|seed-issues|start|loop|watch|say|update`);
}

// Releasing the IPC channel lets a forked runner terminate after settled tasks.
if (typeof process.disconnect === "function" && process.connected) process.disconnect();
