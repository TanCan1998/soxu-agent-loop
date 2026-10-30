/**
 * Loop 自己的「工具行为规则」单一来源。
 *
 * 边界（见 docs/rules-ownership.md）：
 * - 目标项目提供**参数与内容**（automation/policy.json、AGENTS.md、tasks/…），loop 读取；
 * - 本文��属于 loop 自己的**产品行为**：任务状态标签、Issue/PR 标题语法、关闭引用语义。
 *   目标项目只用镜像守卫（SOXU 的 scripts/check-issue-title.mjs、check-commit-msg.mjs）拦住人工提交，
 *   不定义 loop 怎么写。
 *
 * 为什么必须集中：拆分后同一批字面量曾在 7 个文件里各写一遍（59 处），
 * 2026-11-02 的「自动关闭的 Issue 不清标签」就是因为清理路径自己抄了一份标签清单。
 */

/** 任务状态标签：名称、颜色、描述。描述写进 GitHub 标签定义。 */
export const LABEL_META = Object.freeze({
  "agent:ready":       { color: "287a61", description: "就绪：依赖已满足，等待 agent 认领" },
  "agent:waiting":     { color: "c2e0c6", description: "等待前置任务：依赖合并后自动转 ready" },
  "agent:in-progress": { color: "1d76db", description: "执行中：agent 正在开发 / 检查 / 评审" },
  "agent:paused":      { color: "d4c5f9", description: "已暂停：可恢复，需人工检查后手动恢复" },
  "agent:blocked":     { color: "b60205", description: "已阻塞：评审或检查连续失败，需人工介入" },
  "agent:pr":          { color: "0e8a16", description: "已交付：PR 已创建，等待合并与收尾" },
  "agent:release":     { color: "fbca04", description: "发布标记：由发布流程处理" },
});

/** 全部标签名。 */
export const LABELS = Object.freeze(Object.keys(LABEL_META));

/** 语义化的标签常量：读取方按语义引用，不再手写字符串。 */
export const TASK_STATE = Object.freeze({
  ready: "agent:ready",
  waiting: "agent:waiting",
  inProgress: "agent:in-progress",
  paused: "agent:paused",
  blocked: "agent:blocked",
  delivered: "agent:pr",
  release: "agent:release",
});

/** 任务状态标签（互斥）：同一时刻只应存在一个。 */
export const STATE_LABELS = Object.freeze([
  "agent:ready", "agent:waiting", "agent:in-progress", "agent:paused", "agent:blocked", "agent:pr",
]);

/** 不是状态、可与状态共存的标签（发布标记）。 */
export const NON_STATE_LABELS = Object.freeze(["agent:release"]);

/**
 * 任务已结束（合并 / 关闭）后必须清掉的标签。
 *
 * 与 STATE_LABELS 的区别：这里包含 agent:pr——它代表「PR 已交付等待合并」，
 * 任务合并关闭后必须消失，否则面板会一直显示成待合并。
 */
export const STALE_AFTER_MERGE_LABELS = Object.freeze([...STATE_LABELS]);

/** Issue 标题语法：[M<数字>] [TASK-NNN] 描述。dashboard 与依赖调度都靠它解析。 */
export const ISSUE_TITLE_PATTERN = /^\[M\d+\]\s+\[TASK-\d{3,}\]\s+\S/;

/** 由任务元数据生成 Issue 标题。 */
export function issueTitle(milestone, taskId, title) {
  return `[${milestone}] [${taskId}] ${title}`;
}

/** 校验 Issue 标题是否符合语法；返回 null 表示合格。 */
export function validateIssueTitle(title) {
  if (!ISSUE_TITLE_PATTERN.test(String(title ?? ""))) {
    return `Issue 标题必须是 [M<数字>] [TASK-NNN] 描述，实际为：${JSON.stringify(String(title ?? ""))}`;
  }
  return null;
}

/** PR 标题 = 合并提交首行，必须符合同一套 <gitmoji> type(scope): 描述 规范。 */
export function prTitle(issueNumber) {
  return `✨ feat(agent): resolve Issue #${issueNumber}`;
}

/** Runner 提交任务成果时使用的主题（与 PR 标题同源，避免两处漂移）。 */
export function commitSubject(issueNumber) {
  return prTitle(issueNumber);
}

/** 任务归档提交的主题（维护路径使用，不带 Issue 号）。 */
export function archiveCommitSubject(taskId, issueNumber) {
  return `🔧 chore(tasks): 归档 ${taskId}（#${issueNumber} 已合并）`;
}

/** 孤儿任务批量归档。 */
export function orphanArchiveCommitSubject(count) {
  return `🔧 chore(tasks): 归档 ${count} 个已完成任务（孤儿扫描）`;
}

/** PR 正文里的关闭引用。GitHub 只在合并进默认分支时据此自动关闭。 */
export function closingBody(issueNumber, summary = "") {
  const head = `Autonomous SOXU change for #${issueNumber}.`;
  const body = summary ? `${head}\n\n${summary}` : head;
  return `${body}\n\nCloses #${issueNumber}\n`;
}

/** 判定一段文本是否显式关闭了某个 Issue（不区分大小写、跨行）。 */
export function closesIssue(text, issueNumber) {
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve)\\s+#${Number(issueNumber)}\\b`, "im");
  return pattern.test(String(text ?? ""));
}

/** 从文本中提取全部被关闭的 Issue 号。 */
export function closingReferences(text) {
  const pattern = /(?:^|\n)\s*(?:closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve)\s+#(\d+)\b/gim;
  return [...String(text ?? "").matchAll(pattern)].map((match) => Number(match[1]));
}

/** 任务分支名：agent/<namespace>-issue-<n>-<slug>。 */
export function taskBranch({ namespace, issueNumber, slug }) {
  return `agent/${namespace}-issue-${issueNumber}-${slug}`;
}

/** 校验分支名属于哪个任务（返回 issue 号，不匹配返回 null）。 */
export function issueFromBranch(branch) {
  const match = /^agent\/(?:github-issue-|issue-)(\d+)-([a-z0-9-]+)$/.exec(String(branch ?? ""));
  return match ? { issue: Number(match[1]), slug: match[2] } : null;
}
