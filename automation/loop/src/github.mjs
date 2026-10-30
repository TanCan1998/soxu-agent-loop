import { gh, git, run } from "./process.mjs";
import { hasRequiredChecks } from "./branch-protection.mjs";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./config.mjs";
import { validIssue } from "./guards.mjs";
import { loadTaskCatalog, taskIdFromIssueTitle, withGithubIssue } from "./task-catalog.mjs";
import { planGithubQueue, mergedIssueNumbers, waitingLabelDowngrades } from "./github-queue.mjs";
import { readQueueOrder } from "./queue-order.mjs";

/**
 * 任务状态标签的唯一来源：名称、颜色、描述。
 * 描述会写进 GitHub 的标签定义，界面上鼠标悬停即可看到语义。
 */
export const LABEL_META = Object.freeze({
  "agent:ready":       { color: "287a61", description: "就绪：依赖已满足，等待 agent 认领" },
  "agent:waiting":     { color: "c2e0c6", description: "等待前置任务：依赖合并后自动转 ready" },
  "agent:in-progress": { color: "1d76db", description: "执行中：agent 正在开发 / 检查 / 评审" },
  "agent:paused":      { color: "d4c5f9", description: "已暂停：可恢复，需人工检查后手动恢复" },
  "agent:blocked":     { color: "b60205", description: "已阻塞：评审或检查连续失败，需人工介入" },
  "agent:pr":          { color: "0e8a16", description: "已交付：PR 已创建，等待合并与收尾" },
  "agent:release":     { color: "fbca04", description: "发布标记：由发布流程处理" },
});
const LABELS = Object.keys(LABEL_META);
/** 互斥的状态标签：同一时刻只应存在一个。 */
const STATE_LABELS = ["agent:ready", "agent:waiting", "agent:in-progress", "agent:paused", "agent:blocked", "agent:pr"];
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
      await labelIssue(issue.number, "agent:waiting", "agent:ready",
        "依赖已合入集成分支，SOXU 自动把 #" + issue.number + " 从 agent:ready 改回 agent:waiting 等待重新排期。");
    }
    for (const issue of ready) if (issue.promote) {
      await labelIssue(issue.number, "agent:ready", "agent:waiting",
        "前置任务已全部合入集成分支，SOXU 自动把 #" + issue.number + " 从 agent:waiting 提升为 agent:ready，等待认领。");
    }
  }
  return ready;
}
/**
 * 低层标签变更：一次 gh 调用同时增删，并在变更后写一条说明。
 * note 为空时只改标签（用于批量升降级等不需要逐条解释的场景）。
 */
export async function labelIssue(n, add, remove, note = null) {
  const args = ["issue", "edit", String(n)];
  if (add) args.push("--add-label", add);
  if (remove) args.push("--remove-label", remove);
  if (args.length > 3) await gh(args, ROOT);
  if (note) await commentIssue(n, note);
}

/**
 * 设置任务状态（互斥）：加上目标标签，并清掉其它所有状态标签。
 * 之前的实现只删「当前这一步以为的那个标签」，任一环节失败就会留下
 * agent:in-progress + agent:pr 这类矛盾组合（#39 就是这样）；
 * 这里改为先读真实标签再计算差集，保证同一时刻只有一个状态。
 */
export async function setTaskState(n, state, note = null) {
  if (!STATE_LABELS.includes(state)) throw new Error("unsupported task state: " + state);
  const view = JSON.parse(await gh(["issue", "view", String(n), "--json", "labels"], ROOT));
  const current = new Set((view.labels ?? []).map(x => x.name));
  const args = ["issue", "edit", String(n)];
  if (!current.has(state)) args.push("--add-label", state);
  for (const name of STATE_LABELS) {
    if (name !== state && current.has(name)) args.push("--remove-label", name);
  }
  if (args.length > 3) await gh(args, ROOT);
  if (note) await commentIssue(n, note);
  return { added: current.has(state) ? null : state, removed: STATE_LABELS.filter(x => x !== state && current.has(x)) };
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
  // 标签定义带描述：GitHub 界面上悬停即可看到语义，避免只有名字没有含义。
  for (const [name, meta] of Object.entries(LABEL_META)) {
    await gh(["label", "create", name, "--color", meta.color, "--description", meta.description, "--force"], ROOT);
  }
  const existing = JSON.parse(await gh(["issue", "list", "--state", "all", "--limit", "300", "--json", "title"], ROOT));
  const tasks = await loadTaskCatalog();
  for (const task of tasks) {
    if (existing.some(x => taskIdFromIssueTitle(x.title) === task.id)) continue;
    const file = join(ROOT, "tasks", "backlog", `${task.id}.md`);
    // Dependencies are released by listIssues() only after predecessor Issues are CLOSED.
    const label = task.dependencies.length ? "agent:waiting" : "agent:ready";
    const names={"TASK-001":"实现 Pi RPC 进程管理","TASK-002":"实现项目与会话目录","TASK-003":"构建多会话工作区","TASK-004":"实现进程内存预算","TASK-005":"实现 Worktree 集成","TASK-006":"完善发布就绪检查"};
    if (!task.milestone) throw new Error(`Task ${task.id} has no milestone; refusing to seed an unclassified issue`);
    const created = await gh(["issue", "create", "--title", `[${task.milestone}] [${task.id}] ${names[task.id] ?? task.title}`, "--body-file", file, "--label", label], ROOT);
    // 立即把 Issue 号回填到 frontmatter：checkpoint 按 issue 号存、任务按 TASK 号存，
    // 缺 githubIssue 会让 localProgress 永远读不到阶段，人工补容易漏（TASK-033~039 就是这样补的）。
    const issueNumber = Number(/\/issues\/(\d+)/.exec(String(created))?.[1]);
    if (Number.isFinite(issueNumber) && issueNumber > 0) {
      await writeFile(file, withGithubIssue(await readFile(file, "utf8"), issueNumber), "utf8");
      console.log(`Created Issue ${task.id} (${label}) -> #${issueNumber}`);
    } else {
      console.warn(`Created Issue ${task.id} (${label}) but could not parse the issue number; fill githubIssue manually`);
    }
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
