#!/usr/bin/env node
import { ROOT, policy as loadPolicy, integrationBase } from "./config.mjs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { run, git } from "./process.mjs";
import { processIssue } from "./worker.mjs";
import { seedIssues, listIssues, processAuthorizedReleases } from "./github.mjs";
import { listPaused, readCheckpoint } from "./checkpoint.mjs";
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
  return listIssues({ promote: !dryRun });
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
async function recover(selected = null) {
  const includeBlocked = true;
  const candidates = selected ?? (await listPaused(undefined, { includeBlocked })).filter(s => local ? s.local : !s.local);
  if (!candidates.length) { console.log("No recoverable task; nothing to replay or bill."); return; }
  const select = selected ? null : args.find(x => /^#?\d+$/.test(x));
  const tasks = selected ?? (select ? candidates.filter(s => s.issue.number === Number(select.replace("#", ""))) : candidates);
  if (!tasks.length) throw new Error(`No saved task matches ${select}`);
  if (dryRun) { for (const s of tasks) console.log(`would recover #${s.issue.number} at ${s.phase} (${s.status}: ${s.reason ?? "interrupted"})`); return; }
  // Safely preserve dirty edits and let Developer reconcile any main conflicts.
  // Never request paid Pi calls for unsafe/missing worktrees.
  const { eligible, blocked } = await prepareWorktreeRecovery(tasks);
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
  case "cleanup": { if(local || dryRun) throw new Error("cleanup requires GitHub mode"); const results=await cleanup(); console.log(`Merged cleanup: ${results.filter(x=>x.status==="cleaned").length} cleaned, ${results.filter(x=>x.status==="preserved").length} preserved, ${results.filter(x=>["error","invalid-checkpoint"].includes(x.status)).length} errors; unmerged or locked tasks are retained.`); if(results.some(x=>["error","invalid-checkpoint"].includes(x.status))) process.exitCode=1; break; }
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
    if (!local && !dryRun) await cleanup();
    for (let round = 0; round < p.maxRoundsPerInvocation; round++) {
      console.log(`SOXU loop round ${round + 1}/${p.maxRoundsPerInvocation}`);
      const available = await issues();
      if (!available.length) { console.log("No more ready issues"); if (!local && !dryRun) await processAuthorizedReleases(p); break; }
      const results = await once();
      if (problematic(results)) { process.exitCode = 1; console.log("Task paused/blocked; manual resume required. Stop to avoid wasting quota."); break; }
      if (!local && !dryRun) {await cleanup();await processAuthorizedReleases(p);}
      if (dryRun) break;
    }
    break;
  }
  default: throw new Error(`Unknown command '${command}', expected doctor|status|models|seed-issues|start|loop|watch|say|update`);
}

// Releasing the IPC channel lets a forked runner terminate after settled tasks.
if (typeof process.disconnect === "function" && process.connected) process.disconnect();
