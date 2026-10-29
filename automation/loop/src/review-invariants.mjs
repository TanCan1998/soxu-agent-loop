/** A commit is authorized only for the exact tree both tested and approved. */
export function nextPhaseForTree(phase, state, currentTree) {
  if (!currentTree || currentTree !== state.testedTree) return "checks";
  if (phase === "review") return "review";
  if (state.reviewedTree !== currentTree) return "review";
  return "commit";
}

/** Never trust a recovered commit solely because its subject looks familiar. */
export function assertRecoveredCommit(state, { head, parent, tree, subject }) {
  const expectedSubject = `✨ feat(agent): resolve Issue #${state.issue?.number}`;
  // 主题只是工具写提交时的格式约定，不是安全证据；真正的不变量是
  // parent === base 且 tree 同时等于 testedTree 与 reviewedTree。
  // 恢复路径认回的提交（state.commit === head，见 worker 的 agent-commit-recoverable）
  // 允许保留 agent 自己写的提交主题。
  const subjectOk = subject === expectedSubject || state.commit === head;
  if (head === state.base || parent !== state.base || !subjectOk ||
      !tree || tree !== state.testedTree || tree !== state.reviewedTree) {
    throw new Error("Committed HEAD does not match tested/reviewed checkpoint; manual inspection required");
  }
}
