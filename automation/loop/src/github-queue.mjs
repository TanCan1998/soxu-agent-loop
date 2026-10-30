import { planTaskQueue, taskIdFromIssueTitle } from "./task-catalog.mjs";
import { TASK_STATE } from "./rules.mjs";

function labelsOf(issue) { return new Set((issue.labels ?? []).map(x => x.name)); }

/**
 * A predecessor is complete only if its Issue is CLOSED and a PR targeting main
 * with a `Closes #n` closing reference has actually merged. Manual Issue closure
 * and merely created PRs cannot unlock dependent tasks.
 */
export function mergedIssueNumbers(prs, base = "main") {
  const found = new Set();
  for (const pr of prs) {
    if (pr.baseRefName !== base || !pr.mergedAt) continue;
    const regex = /(?:^|\n)\s*(?:closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve)\s+#(\d+)\b/gim;
    for (const m of String(pr.body ?? "").matchAll(regex)) found.add(Number(m[1]));
  }
  return found;
}

export function planGithubQueue(issues, catalog, mergedNumbers = new Set(), order = []) {
  const mapped = new Map();
  for (const issue of issues) {
    const id = taskIdFromIssueTitle(issue.title);
    if (!id) continue;
    if (mapped.has(id)) throw new Error(`Duplicate GitHub issues for ${id}; inspect before scheduling`);
    mapped.set(id, issue);
  }
  const completed = new Set();
  for (const task of catalog) {
    const issue = mapped.get(task.id);
    // Completion is "merged into the integration branch", not "issue closed":
    // Closes #N only auto-closes when merging into the default branch (main).
    if (issue && mergedNumbers.has(issue.number)) completed.add(task.id);
  }
  const { ready: eligible } = planTaskQueue(catalog, completed);
  const runnable = new Set(eligible.map(x => x.id));
  const priorities = new Map(catalog.map(t => [t.id, t.priority]));
  const output = [];
  for (const issue of issues) {
    if (issue.state !== "OPEN") continue;
    const labels = labelsOf(issue);
    if ([TASK_STATE.paused, TASK_STATE.blocked, TASK_STATE.delivered, TASK_STATE.inProgress].some(x => labels.has(x))) continue;
    if (!labels.has(TASK_STATE.ready) && !labels.has(TASK_STATE.waiting)) continue;
    const id = taskIdFromIssueTitle(issue.title);
    // TASK-tagged issues must exist in the local validated catalog.
    if (id && !runnable.has(id)) continue;
    output.push({...issue, taskId: id, priority: id ? priorities.get(id) : 'P1', promote: labels.has(TASK_STATE.waiting)});
  }
  const rank = {P0:0,P1:1,P2:2};
  // 用户自定义顺序优先（看板上拖动排序），未列出的按原规则排在后面。
  const custom = new Map(order.map((n, i) => [n, i]));
  const fallback = order.length + output.length + 1;
  return output.sort((a, b) => {
    const ca = custom.get(a.number), cb = custom.get(b.number);
    if (ca !== undefined || cb !== undefined) return (ca ?? fallback) - (cb ?? fallback);
    return rank[a.priority] - rank[b.priority] || a.number - b.number;
  });
}

/** Downgrade legacy ready labels when their dependencies are not yet merged. */
export function waitingLabelDowngrades(issues, catalog, runnable) {
  const readyIds = new Set(runnable.map(x => x.number));
  const taskIds = new Set(catalog.map(t => t.id));
  return issues.filter(issue => {
    if (issue.state !== "OPEN" || readyIds.has(issue.number)) return false;
    const id = taskIdFromIssueTitle(issue.title);
    if (!id || !taskIds.has(id)) return false;
    const labels = labelsOf(issue);
    return labels.has(TASK_STATE.ready) && ![TASK_STATE.paused,TASK_STATE.blocked,TASK_STATE.delivered,TASK_STATE.inProgress].some(x => labels.has(x));
  });
}
