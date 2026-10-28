import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./config.mjs";

const ID = /^TASK-\d{3,}$/;
const FILE = /^TASK-\d{3,}\.md$/;
const PRIORITY = { P0: 0, P1: 1, P2: 2 };

/** Only a deliberately tiny, auditable subset of YAML is accepted for task metadata. */
export function parseTaskDocument(filename, body) {
  if (!FILE.test(filename)) throw new Error(`Invalid task filename: ${filename}`);
  const id = filename.slice(0, -3);
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`Missing task frontmatter: ${id}`);
  const meta = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const kv = trimmed.match(/^(id|priority|dependencies|milestone):\s*(.*?)\s*$/);
    if (!kv) throw new Error(`Unknown metadata in ${id}: ${trimmed}`);
    if (meta.has(kv[1])) throw new Error(`Duplicate ${kv[1]} in ${id}`);
    meta.set(kv[1], kv[2]);
  }
  if (meta.get("id") !== id) throw new Error(`Task ID differs from filename: ${id}`);
  const priority = meta.get("priority");
  if (!Object.hasOwn(PRIORITY, priority)) throw new Error(`Invalid priority in ${id}`);
  const deps = meta.get("dependencies");
  if (!deps?.startsWith("[") || !deps.endsWith("]")) throw new Error(`Invalid dependencies in ${id}; use [TASK-001, TASK-002]`);
  const dependencies = deps.slice(1, -1).trim() ? deps.slice(1, -1).split(",").map(x => x.trim()) : [];
  if (dependencies.some(x => !ID.test(x)) || new Set(dependencies).size !== dependencies.length || dependencies.includes(id)) {
    throw new Error(`Invalid or duplicate dependencies in ${id}`);
  }
  const milestone=meta.get("milestone") ?? null;
  if (milestone !== null && !/^M[0-4]$/.test(milestone)) throw new Error(`Invalid milestone in ${id}`);
  const title = body.match(/^#\s+(.+)$/m)?.[1];
  if (!title) throw new Error(`Missing task title: ${id}`);
  return { id, number: Number(id.slice(5)), title, body, priority, dependencies, milestone };
}

export function validateTaskCatalog(tasks) {
  const map = new Map(tasks.map(t => [t.id, t]));
  if (map.size !== tasks.length) throw new Error("Duplicate task IDs");
  const visited = new Set(), active = new Set();
  function visit(id) {
    if (active.has(id)) throw new Error(`Dependency cycle at ${id}`);
    if (visited.has(id)) return;
    const task = map.get(id);
    if (!task) throw new Error(`Unknown dependency: ${id}`);
    active.add(id);
    for (const dependency of task.dependencies) visit(dependency);
    active.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
  return tasks;
}

export async function loadTaskCatalog(root = ROOT) {
  const tasks = [];
  for (const category of ["backlog", "done"]) {
    const dir = join(root, "tasks", category);
    let files;
    try { files = (await readdir(dir)).filter(x => FILE.test(x)).sort(); }
    // Either directory may be absent: an empty backlog is normal once every task is
    // archived, and an absent done/ simply means nothing finished yet.
    catch (err) { if (err.code === "ENOENT") continue; throw err; }
    for (const file of files) {
      tasks.push({...parseTaskDocument(file, await readFile(join(dir, file), "utf8")), archived: category === "done"});
    }
  }
  return validateTaskCatalog(tasks);
}

export function orderTasks(tasks) {
  return [...tasks].sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.number - b.number);
}

/** A dependency is a TASK ID, never a GitHub Issue number. Unknown states fail closed. */
export function planTaskQueue(tasks, completedIds, unavailableIds = new Set()) {
  validateTaskCatalog(tasks);
  const ready = [], waiting = [];
  for (const task of orderTasks(tasks)) {
    if (completedIds.has(task.id) || unavailableIds.has(task.id) || task.archived) continue;
    const missing = task.dependencies.filter(id => !completedIds.has(id));
    if (missing.length) waiting.push({ ...task, missing });
    else ready.push(task);
  }
  return { ready, waiting };
}

export function taskIdFromIssueTitle(title) {
  return /^(?:\[(?:M[0-4]|未归类)\]\s+)?\[(TASK-\d{3,})\](?:\s|$)/.exec(String(title))?.[1] ?? null;
}
