import { dataRoot } from "./config.mjs";
import { ROOT } from "./config.mjs";
import { join } from "node:path";
import { run, git } from "./process.mjs";
import { readCheckpoint } from "./checkpoint.mjs";
import { loadTaskCatalog, planTaskQueue } from "./task-catalog.mjs";

/** Local completion is not integration: dependent worktrees must start from a main containing predecessors. */
export async function integratedLocalTask(task, checkpoint, root = ROOT, base = "main") {
  if (checkpoint?.status !== "done" || checkpoint.local !== true || checkpoint.issue?.number !== task.number) return false;
  const commit = checkpoint.commit ?? (checkpoint.branch ? await git(["rev-parse", checkpoint.branch], root).catch(() => null) : null);
  if (!commit || !/^[0-9a-f]{40,64}$/.test(commit)) return false;
  const result = await run("git", ["merge-base", "--is-ancestor", commit, base], {cwd: root, allowFailure: true, timeoutMs: 10000});
  return result.code === 0;
}

export async function localTasks(root = ROOT, base = "main") {
  const catalog = await loadTaskCatalog(root);
  const states = await Promise.all(catalog.map(t => readCheckpoint(t.number, join(dataRoot(root), "checkpoints"), true)));
  const unavailable = new Set(), completed = new Set();
  for (let i = 0; i < catalog.length; i++) {
    if (states[i] || catalog[i].archived) unavailable.add(catalog[i].id); // paused, running, blocked, done: never start twice
    if (await integratedLocalTask(catalog[i], states[i], root, base)) completed.add(catalog[i].id);
  }
  const { ready, waiting } = planTaskQueue(catalog, completed, unavailable);
  return {ready: ready.map(t => ({...t, body: t.body, number: t.number})), waiting};
}
