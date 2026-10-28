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
