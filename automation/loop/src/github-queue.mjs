import { planTaskQueue, taskIdFromIssueTitle } from "./task-catalog.mjs";

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

export function planGithubQueue(issues, catalog, mergedNumbers = new Set()) {
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
    if (issue?.state === "CLOSED" && mergedNumbers.has(issue.number)) completed.add(task.id);
  }
  const { ready: eligible } = planTaskQueue(catalog, completed);
  const runnable = new Set(eligible.map(x => x.id));
  const priorities = new Map(catalog.map(t => [t.id, t.priority]));
  const output = [];
  for (const issue of issues) {
    if (issue.state !== "OPEN") continue;
    const labels = labelsOf(issue);
    if (['agent:paused', 'agent:blocked', 'agent:pr', 'agent:in-progress'].some(x => labels.has(x))) continue;
    if (!labels.has('agent:ready') && !labels.has('agent:waiting')) continue;
    const id = taskIdFromIssueTitle(issue.title);
    // TASK-tagged issues must exist in the local validated catalog.
    if (id && !runnable.has(id)) continue;
    output.push({...issue, taskId: id, priority: id ? priorities.get(id) : 'P1', promote: labels.has('agent:waiting')});
  }
  const rank = {P0:0,P1:1,P2:2};
  return output.sort((a,b) => rank[a.priority] - rank[b.priority] || a.number - b.number);
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
    return labels.has('agent:ready') && !['agent:paused','agent:blocked','agent:pr','agent:in-progress'].some(x => labels.has(x));
  });
}
