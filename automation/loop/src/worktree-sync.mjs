import { dataRoot } from "./config.mjs";

import { mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT } from "./config.mjs";
import { git } from "./process.mjs";
import { writeCheckpoint } from "./checkpoint.mjs";

const EARLY = new Set(["worktree", "install", "develop"]);
const RECHECK = new Set(["checks", "review", "finalChecks", "recoveryInstall"]);
const NAME = /^(local|github)-issue-([1-9]\d*)\.json$/;
const samePath = (a,b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

async function loadStates(root) {
  const dir = join(dataRoot(root), "checkpoints");
  let filenames;
  try { filenames = await readdir(dir); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const result = [];
  for (const file of filenames.filter(f => NAME.test(f)).sort()) {
    const [, kind, number] = NAME.exec(file);
    const state = JSON.parse(await readFile(join(dir, file), "utf8"));
    if (state?.issue?.number !== Number(number) || Boolean(state.local) !== (kind === "local"))
      throw new Error("Checkpoint identity mismatch: " + file);
    result.push({ state, dir });
  }
  return result;
}

function taskLock(root, state) {
  return join(root, ".soxu", "locks", (state.local ? "local" : "github") + "-issue-" + state.issue.number + ".lock");
}

async function lockState(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!Number.isInteger(value.pid) || value.pid <= 0) return "unsafe";
    try { process.kill(value.pid, 0); return "active"; }
    catch (e) { return e.code === "ESRCH" ? "orphan" : "unsafe"; }
  } catch (e) {
    return e.code === "ENOENT" ? "none" : "unsafe";
  }
}

async function inspect(root, state) {
  const info = {
    issue: state.issue.number, local: Boolean(state.local), phase: state.phase,
    status: state.status, branch: state.branch ?? null, directory: state.directory ?? null,
    ahead: null, behind: null, dirty: null, lock: "unknown", canSync: false, reason: null,
  };
  const wtRoot = resolve(root, "..", "soxu-worktrees");
  if (typeof state.directory !== "string") { info.reason = "no-worktree"; return info; }
  const rel = relative(wtRoot, resolve(state.directory));
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || resolve(state.directory).includes("\0")) {
    info.reason = "outside-managed-worktrees"; return info;
  }
  try {
    const parentReal = await realpath(wtRoot);
    const wtReal = await realpath(state.directory);
    const realRel = relative(parentReal, wtReal);
    if (!realRel || realRel === ".." || realRel.startsWith(".." + sep)) {
      info.reason = "worktree-symlink-escape"; return info;
    }
    const top = await git(["rev-parse", "--show-toplevel"], state.directory);
    const branch = await git(["branch", "--show-current"], state.directory);
    const prefix = "agent/" + (state.local ? "local" : "github") + "-issue-" + state.issue.number + "-";
    const legacy = "agent/issue-" + state.issue.number + "-";
    if (!samePath(await realpath(top),wtReal) ||
        branch !== state.branch || !(branch.startsWith(prefix) || branch.startsWith(legacy))) {
      info.reason = "worktree-identity-mismatch"; return info;
    }
    info.lock = await lockState(taskLock(root, state));
    info.dirty = Boolean(await git(["status", "--porcelain", "--untracked-files=all"], state.directory));
    const counts = await git(["rev-list", "--left-right", "--count", "HEAD...origin/main"], state.directory);
    [info.ahead, info.behind] = counts.split(/\s+/).map(Number);
    const head = await git(["rev-parse", "HEAD"], state.directory);
    const intent = state.syncPending;
    if (intent && head !== intent.from && head !== intent.to) info.reason = "unexpected-sync-head";
    else if (state.status !== "running" && state.status !== "paused" && state.status !== "blocked") info.reason = "not-recoverable";
    else if (info.lock === "active" || info.lock === "unsafe") info.reason = "worktree-locked";
    else if (!intent && state.base && state.base !== head) info.reason = "checkpoint-base-mismatch";
    else if (info.ahead > 0) info.reason = "diverged-from-main";
    // A checkpoint in tests/review/install can resume on an already-current
    // branch without invalidating its tested/reviewed evidence.
    else if (info.behind === 0 && !intent) info.reason = "up-to-date";
    else if ((!EARLY.has(state.phase) && !RECHECK.has(state.phase)) || state.commit) info.reason = "advanced-phase";
    else { info.canSync = true; info.reason = info.dirty ? "dirty-sync-eligible" : null; }
  } catch (e) {
    info.reason = "inspection-failed: " + (e.code ?? "git-error");
  }
  return info;
}


/** The stash is an immutable recovery backup; never pop/drop it automatically. */
async function backupSha(wt, marker) {
  const lines = (await git(["stash", "list", "--format=%H%x09%gs"], wt)).split("\n");
  const found = lines.map(line => line.split("\t")).find(parts => parts.length > 1 && parts.slice(1).join("\t").endsWith(marker));
  return found?.[0] ?? null;
}
async function hasUnmerged(wt) {
  return (await git(["ls-files", "--unmerged"], wt)).trim().length > 0;
}
async function updateCheckpointAfterSync(state, dir, to, backup, conflicts) {
  const next = { ...state, base: to, phase: conflicts ? "develop" : RECHECK.has(state.phase) ? "recoveryInstall" : "install" };
  next.testedTree = null; next.reviewedTree = null;
  if (backup) next.syncBackup = { sha: backup.sha, marker: backup.marker, target: to };
  if (conflicts) {
    next.mergeConflict = {
      stashSha: backup.sha, marker: backup.marker,
      message: "Prior task edits must be reconciled with latest origin/main; verify entire stash backup, resolve conflicts, preserve both intended behavior and latest main.",
    };
    next.conflictFixAttempts = 0;
    next.feedback = "Resolve worktree/main conflicts before completing the issue. Preserve latest main changes, reapply all useful task edits from the saved Git stash, and stage resolved files. Do not change HEAD, force reset, or drop the backup.";
  }
  delete next.syncPending;
  await writeCheckpoint(next, dir);
}

/** Sync with dirty task edits by first backing them up in the Git stash. */
async function reconcileDirty(state, dir, wt, target) {
  let pending = state.syncPending;
  const head = await git(["rev-parse", "HEAD"], wt);
  if (!pending) {
    pending = { mode: "dirty", from: head, to: target, marker: "soxu-main-sync-" + state.issue.number + "-" + randomUUID() };
    await writeCheckpoint({ ...state, syncPending: pending }, dir);
  }
  if (pending.mode !== "dirty" || pending.to !== target || !pending.marker)
    throw new Error("invalid-or-outdated-dirty-sync");
  // If killed after stash applied but before checkpoint write, do not reapply and
  // overwrite anything. Let the Developer compare surviving edits with backup.
  const dirty = Boolean(await git(["status", "--porcelain", "--untracked-files=all"], wt));
  let sha = await backupSha(wt, pending.marker);
  if (head === pending.to && dirty) {
    if (!sha) throw new Error("missing-stash-backup");
    await updateCheckpointAfterSync(state, dir, target, { sha, marker: pending.marker }, true);
    return "synced-conflicts";
  }
  if (head === pending.from) {
    if (!sha && dirty) {
      await git(["stash", "push", "--include-untracked", "-m", pending.marker], wt);
      sha = await backupSha(wt, pending.marker);
    }
    if (!sha) throw new Error("missing-stash-backup");
    if (await git(["status", "--porcelain", "--untracked-files=all"], wt))
      throw new Error("worktree-not-clean-after-backup");
    await git(["merge", "--ff-only", target], wt);
  } else if (head !== pending.to) {
    throw new Error("unexpected-HEAD-during-sync");
  }
  if (!sha) throw new Error("missing-stash-backup");
  let applyFailed = false;
  try { await git(["stash", "apply", "--index", sha], wt); }
  catch { applyFailed = true; }
  const conflicts = applyFailed || await hasUnmerged(wt);
  await updateCheckpointAfterSync(state, dir, target, { sha, marker: pending.marker }, conflicts);
  return conflicts ? "synced-conflicts" : "synced";
}

/**
 * Audit only by default; with --sync use worktree-local lock and fast-forward.
 * Dirty early-phase task edits are saved to an immutable stash backup first,
 * then re-applied on latest main. Conflicts are delegated to the Pi Developer;
 * both stash backup and checkpoint survive interruption.
 */
export async function inspectWorktrees({ root = ROOT, sync = false, issueNumbers = null } = {}) {
  if (sync) await git(["fetch", "origin", "main"], root);
  const entries = (await loadStates(root)).filter(({state}) => !issueNumbers || issueNumbers.some(item =>
    item.id === state.issue.number && item.local === Boolean(state.local)));
  const output = [];
  for (const { state, dir } of entries) {
    let item = await inspect(root, state);
    if (!sync || !item.canSync) { output.push(item); continue; }
    const path = taskLock(root, state);
    await mkdir(dirname(path), { recursive: true });
    let handle;
    try {
      if (item.lock === "orphan") await rm(path, { force: true });
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();
      handle = null;
    } catch {
      if (handle) await handle.close();
      output.push({ ...item, canSync: false, reason: "lock-acquisition-failed" });
      continue;
    }
    try {
      const wt = state.directory;
      const currentHead = await git(["rev-parse", "HEAD"], wt);
      const to = await git(["rev-parse", "origin/main"], wt);
      const dirty = Boolean(await git(["status", "--porcelain", "--untracked-files=all"], wt));
      if (!state.syncPending && state.base && state.base !== currentHead)
        throw new Error("checkpoint-base-mismatch");
      if (state.syncPending && state.syncPending.from !== currentHead && state.syncPending.to !== currentHead)
        throw new Error("unexpected-sync-head");
      const pending = state.syncPending;
      // Ensure only a true descendant is accepted. Other task commits are never rewritten.
      await git(["merge-base", "--is-ancestor", pending?.from ?? currentHead, to], wt);
      let result;
      if (pending?.mode === "dirty" || (!pending && dirty)) {
        result = await reconcileDirty(state, dir, wt, to);
      } else {
        if (currentHead !== to) await git(["merge", "--ff-only", pending?.to ?? to], wt);
        const after = await git(["rev-parse", "HEAD"], wt);
        if (after !== to) throw new Error("unexpected-fast-forward-HEAD");
        await updateCheckpointAfterSync(state, dir, after, null, false);
        result = "synced";
      }
      item = { ...item, ahead: 0, behind: 0, phase: result === "synced-conflicts" ? "develop" : RECHECK.has(state.phase) ? "recoveryInstall" : "install",
        reason: result, updatedBase: to, canSync: false };
    } catch (e) {
      item.reason = "sync-failed: " + String(e.message ?? e.code ?? "git-or-checkpoint").slice(0, 160);
      item.canSync = false;
    } finally {
      await rm(path, { force: true });
    }
    output.push(item);
  }
  return output;
}

/** A single policy for manual CLI resume and natural-language recovery. */
export async function prepareWorktreeRecovery(states, options = {}) {
  if (!states.length) return { eligible: [], blocked: [], rows: [] };
  const rows = await inspectWorktrees({
    ...options, sync: true,
    issueNumbers: states.map(s => ({ id: s.issue.number, local: Boolean(s.local) })),
  });
  const byKey = new Map(rows.map(row => [String(row.local) + ":" + row.issue, row]));
  const eligible = [], blocked = [];
  for (const state of states) {
    const key = String(Boolean(state.local)) + ":" + state.issue.number;
    const row = byKey.get(key);
    const allowed = row && (["synced", "synced-conflicts", "up-to-date", "no-worktree"].includes(row.reason));
    if (allowed) {
      if (row.reason === "synced-conflicts")
        console.log("Worktree #" + row.issue + " rebased onto latest main with recoverable conflicts; Pi Developer will resolve from stash backup.");
      else if (row.reason === "synced")
        console.log("Worktree #" + row.issue + " safely updated to latest main.");
      eligible.push(state);
    } else {
      console.error("Worktree #" + state.issue.number + " cannot safely reconcile (" +
        (row?.reason ?? "missing-checkpoint") + "); checkpoint and all task edits preserved.");
      blocked.push(state);
    }
  }
  return { eligible, blocked, rows };
}
