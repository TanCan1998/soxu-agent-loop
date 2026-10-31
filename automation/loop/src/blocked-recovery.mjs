/**
 * 人工确认根因已修复后，把「连续阻塞重试」计数清零。
 *
 * 只改这一个字段：状态、阶段、commit、worktree 目录都不动，所以下次 resume
 * 仍然从原来的阶段继续。计数是防「无限付费重试」的闸，因此只能由人显式调用
 * （cli.mjs reset-blocked --issue N），不提供自动重置。
 */
export function resetBlockedRecovery(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return { reset: false, reason: "invalid-state" };
  const before = Number.isInteger(state.blockedRecoveryCount) ? state.blockedRecoveryCount : 0;
  if (before <= 0) return { reset: false, reason: "already-zero", before: 0 };
  state.blockedRecoveryCount = 0;
  return { reset: true, before };
}

/**
 * blocked 任务自动重试是有界的：连续 N 次仍被评审/检查判为 blocked 后不再抢占队列，
 * 交给人工判断。这样既减少人工介入（自动重试），又不会让一个坏任务永久堵住队列。
 */
export function partitionRecoveryCandidates(candidates, maxBlockedRecoveries = 2) {
  const limit = Number.isInteger(maxBlockedRecoveries) && maxBlockedRecoveries >= 0 ? maxBlockedRecoveries : 2;
  const actionable = [];
  const exhausted = [];
  for (const candidate of candidates) {
    const count = Number.isInteger(candidate?.blockedRecoveryCount) ? candidate.blockedRecoveryCount : 0;
    (candidate?.status === "blocked" && count >= limit ? exhausted : actionable).push(candidate);
  }
  return { actionable, exhausted };
}
