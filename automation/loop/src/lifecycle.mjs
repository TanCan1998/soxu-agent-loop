/**
 * 任务生命周期「意图」层。
 *
 * 调用方表达意图（任务已合并 / 已交付 / 已暂停），由本模块决定要改哪个标签、
 * 写什么注释、要不要关闭 Issue。规则本体在 rules.mjs，GitHub 出口在 process.mjs 的 gh()。
 *
 * 为什么要有这一层：2026-11-02 之前，「关闭 Issue + 清标签」写在 merged-cleanup.mjs 里，
 * 「打 agent:pr」写在 worker.mjs 里，各自维护一份标签清单，于是 GitHub 自动关闭 Issue 的路径
 * 完全没清标签。状态机集中后，这类遗漏只可能出现在一个文件里。
 */
import { STALE_AFTER_MERGE_LABELS } from "./rules.mjs";

/** 返回该清掉的陈旧标签（只返回实际存在的，避免无意义的 gh 调用）。 */
export function staleLabels(issueLabels) {
  const present = new Set((issueLabels ?? []).map((label) => label?.name ?? label));
  return STALE_AFTER_MERGE_LABELS.filter((name) => present.has(name));
}

/**
 * 任务完成意图：清理未完成态标签 → 关闭 Issue（已关闭时补清标签）。
 *
 * 幂等：检查点里记 `issueClosed`，两种终态都不再重复询问 GitHub。
 * - "closed"：本函数关闭并已清标签；
 * - "already-closed-clean"：GitHub 因 PR 正文的 Closes #N 自动关掉，本函数补清了标签。
 */
export async function completeMergedIssue(exec, state, issueNumber, base) {
  if (state.issueClosed === "closed" || state.issueClosed === "already-closed-clean") return "cached";
  try {
    // 一次调用同时取 state 与 labels：自动关闭的 Issue 同样要清标签，清理与关闭必须解耦。
    const view = JSON.parse((await exec("gh", ["issue", "view", String(issueNumber), "--json", "state,labels"])).stdout);
    const stale = staleLabels(view.labels);
    if (stale.length) {
      await exec("gh", ["issue", "edit", String(issueNumber), ...stale.flatMap((name) => ["--remove-label", name])]);
    }
    if (view.state !== "OPEN") {
      state.issueClosed = "already-closed-clean";
      return "already-closed";
    }
    await exec("gh", ["issue", "close", String(issueNumber), "--comment", `已合入集成分支 ${base}；release 发布到 main 后随版本生效。`]);
    state.issueClosed = "closed";
    return "closed";
  } catch {
    return "unknown";
  }
}
