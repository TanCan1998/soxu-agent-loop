import { gh, git, run } from "./process.mjs";
import { hasRequiredChecks } from "./branch-protection.mjs";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./config.mjs";
import { validIssue } from "./guards.mjs";
import { loadTaskCatalog, taskIdFromIssueTitle } from "./task-catalog.mjs";
import { planGithubQueue, mergedIssueNumbers, waitingLabelDowngrades } from "./github-queue.mjs";
import { readQueueOrder } from "./queue-order.mjs";

const LABELS = ["agent:ready", "agent:waiting", "agent:in-progress", "agent:blocked", "agent:paused", "agent:pr", "agent:release"];
export async function listIssues({promote = false, base = "main"} = {}) {
  // Both open and closed TASK issues are needed; a PR being created is NOT a merged dependency.
  const text = await gh(["issue", "list", "--state", "all", "--limit", "1000", "--json", "number,title,body,labels,state"], ROOT);
  const values = JSON.parse(text).filter(validIssue);
  const catalog = await loadTaskCatalog();
  const prerequisiteIds = new Set(catalog.flatMap(task => task.dependencies));
  const needsMergeEvidence = values.some(issue => issue.state === "CLOSED" && prerequisiteIds.has(taskIdFromIssueTitle(issue.title)));
  // Avoid a second remote request until there is an actual closed prerequisite to verify.
  const merged = needsMergeEvidence
    ? JSON.parse(await gh(["pr", "list", "--state", "merged", "--limit", "1000", "--json", "body,baseRefName,mergedAt"], ROOT))
    : [];
  const ready = planGithubQueue(values, catalog, mergedIssueNumbers(merged, base), await readQueueOrder(ROOT));
  if (promote) {
    // A previously seeded v1.5 ready task may not have had dependency metadata honored.
    for (const issue of waitingLabelDowngrades(values, catalog, ready)) {
      await labelIssue(issue.number, "agent:waiting", "agent:ready");
    }
    for (const issue of ready) if (issue.promote) {
      await labelIssue(issue.number, "agent:ready", "agent:waiting");
    }
  }
  return ready;
}
export async function labelIssue(n, add, remove) {
  if (add) await gh(["issue", "edit", String(n), "--add-label", add], ROOT);
  if (remove) await gh(["issue", "edit", String(n), "--remove-label", remove], ROOT);
}
export async function commentIssue(n, message) {
  const dir = await mkdtemp(join(tmpdir(), "soxu-"));
  try { const p = join(dir, "comment.md"); await writeFile(p, message); await gh(["issue", "comment", String(n), "--body-file", p], ROOT); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
export async function createPr(n, branch, summary, base = "main") {
  const dir = await mkdtemp(join(tmpdir(), "soxu-"));
  try {
    const p = join(dir, "body.md");
    await writeFile(p, `Autonomous SOXU change for #${n}.\n\n${summary}\n\nCloses #${n}\n`);
    // PR 标题会成为合并提交的首行，必须符合同一套 <gitmoji> type(scope): 描述 规范，
  // 否则目标仓库的 commit policy 会在 dev/main 上判定失败。
  const title = `✨ feat(agent): resolve Issue #${n}`;
  return await gh(["pr", "create", "--base", base, "--head", branch, "--title", title, "--body-file", p], ROOT);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export async function branchProtectionEnabled(branch = "main") {
  // 若 GitHub 禁止读取或仓库未开启保护，拒绝自动合并。
  // GitHub rulesets 还应由仓库所有者在 Settings 中明确检查。
  const result = await run("gh", ["api", `repos/{owner}/{repo}/branches/${branch}/protection`], { cwd: ROOT, allowFailure: true, timeoutMs: 30000 });
  if (result.code !== 0) return false;
  try {
    const v = JSON.parse(result.stdout);
    return hasRequiredChecks(v);
  } catch { return false; }
}
export async function autoMerge(prUrl) { await gh(["pr", "merge", prUrl, "--auto", "--squash"], ROOT); }
export async function seedIssues() {
  for (const name of LABELS) await gh(["label", "create", name, "--color", name === "agent:blocked" ? "b60205" : "287a61", "--force"], ROOT);
  const existing = JSON.parse(await gh(["issue", "list", "--state", "all", "--limit", "300", "--json", "title"], ROOT));
  const tasks = await loadTaskCatalog();
  for (const task of tasks) {
    if (existing.some(x => taskIdFromIssueTitle(x.title) === task.id)) continue;
    const file = join(ROOT, "tasks", "backlog", `${task.id}.md`);
    // Dependencies are released by listIssues() only after predecessor Issues are CLOSED.
    const label = task.dependencies.length ? "agent:waiting" : "agent:ready";
    const names={"TASK-001":"实现 Pi RPC 进程管理","TASK-002":"实现项目与会话目录","TASK-003":"构建多会话工作区","TASK-004":"实现进程内存预算","TASK-005":"实现 Worktree 集成","TASK-006":"完善发布就绪检查"};
    await gh(["issue", "create", "--title", `[${task.milestone ?? "未归类"}] [${task.id}] ${names[task.id] ?? task.title}`, "--body-file", file, "--label", label], ROOT);
    console.log(`Created Issue ${task.id} (${label})`);
  }
}

export async function processAuthorizedReleases(p) {
  if (!p.autoRelease) return;
  const text = await gh(["issue", "list", "--state", "open", "--label", "agent:release", "--limit", "20", "--json", "number,title,body"], ROOT);
  for (const issue of JSON.parse(text)) {
    // Release intent must be explicit, separate from development issues.
    const v = String(issue.body ?? "").match(/(?:^|\n)version:\s*(0\.\d+\.\d+(?:-rc\.\d+)?)(?:\r?\n|$)/);
    if (!v) { console.warn(`release issue #${issue.number} missing exact version`); continue; }
    try {
      const out = await run(process.execPath, ["scripts/release.mjs", v[1]], { cwd: ROOT, timeoutMs: 120000 });
      await commentIssue(issue.number, `Release tag requested for ${v[1]}; GitHub Actions is responsible for building and publishing.\n\n${out.stdout}`);
      await gh(["issue", "close", String(issue.number), "--reason", "completed"], ROOT);
    } catch (err) {
      console.warn(`Release not ready #${issue.number}: ${err.message.slice(0,400)}`);
    }
  }
}
