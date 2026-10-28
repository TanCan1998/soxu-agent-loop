import { ROOT } from "./config.mjs";

const NAMES = { M0: "工程治理", M1: "产品原型", M2: "多 Agent", M3: "开发工具", M4: "交付发布" };

/**
 * Milestone progress derived from the local catalog and checkpoints only.
 * GitHub stays the source of truth when reachable; this keeps the roadmap usable
 * offline instead of rendering "details unavailable".
 */
export function buildLocalRoadmap(tasks, progress) {
  const stages = Object.fromEntries(Object.keys(NAMES).map(id => [id, { id, name: NAMES[id], total:0, merged:0, running:0, paused:0, unknown:0, issues:[], items:[] }]));
  const status = new Map();
  for (const group of ["done","running","paused","blocked","pending"]) {
    for (const item of progress?.[group] ?? []) status.set(item.id, group);
  }
  let unclassified = 0;
  for (const task of tasks) {
    const stage = task.milestone && stages[task.milestone] ? stages[task.milestone] : null;
    if (!stage) { unclassified++; continue; }
    const state = status.get(task.number) ?? (task.archived ? "done" : "pending");
    stage.total += 1;
    stage.issues.push(task.number);
    if (state === "done") stage.merged += 1;
    if (state === "running") stage.running += 1;
    if (state === "paused" || state === "blocked") stage.paused += 1;
    stage.items.push({
      number: task.number,
      title: task.title,
      state: state === "done" ? "CLOSED" : "OPEN",
      labels: state === "blocked" ? ["agent:blocked"] : state === "paused" ? ["agent:paused"] : state === "running" ? ["agent:in-progress"] : [],
      merged: state === "done",
      url: null,
      localStatus: state,
    });
  }
  return { source: "local", stages: Object.values(stages), unclassified, limited: false, note: "本地检查点推定，未查询 GitHub" };
}
