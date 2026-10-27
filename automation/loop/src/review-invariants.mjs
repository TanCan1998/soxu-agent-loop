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
  if (head === state.base || parent !== state.base || subject !== expectedSubject ||
      !tree || tree !== state.testedTree || tree !== state.reviewedTree) {
    throw new Error("Committed HEAD does not match tested/reviewed checkpoint; manual inspection required");
  }
}
