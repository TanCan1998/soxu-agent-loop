/** Manual recovery executor. No Pi call is made until intent and checkpoint are verified. */
import { listPaused } from "./checkpoint.mjs";
import { parseRecoveryIntent, selectRecoveryCandidates } from "./recovery-intent.mjs";
import { processIssue } from "./worker.mjs";
import { prepareWorktreeRecovery } from "./worktree-sync.mjs";

export async function recoverFromSentence(sentence, { policy, localOnly = false, githubOnly = false, dryRun = false, signal } = {}) {
  const intent = parseRecoveryIntent(sentence);
  const candidates = selectRecoveryCandidates(await listPaused(), intent, { localOnly, githubOnly });
  if (!candidates.length) {
    console.log("没有暂停的任务，无需恢复；没有启动 Pi、没有调用模型 API。");
    return [];
  }
  console.log(`识别恢复意图：${intent.scope}${intent.issueNumber ? ` #${intent.issueNumber}` : ""}`);
  if (dryRun) {
    for (const s of candidates) console.log(`仅预览：#${s.issue.number} (${s.phase}; ${s.reason || "unknown"}; ${s.local ? "local" : "GitHub"})`);
    return candidates.map(s => ({ status: "dry-run", issue: s.issue.number }));
  }
  const { eligible, blocked } = await prepareWorktreeRecovery(candidates);
  const results = blocked.map(s => ({ status: "paused", issue: s.issue.number, reason: "worktree-sync-unsafe" }));
  // Explicit all can perform multiple finite batches; stop immediately if one batch pauses again.
  for (let i = 0; i < eligible.length; i += policy.maxConcurrentAgents) {
    const batch = await Promise.all(eligible.slice(i, i + policy.maxConcurrentAgents).map(s => processIssue(s.issue, { policy, local: Boolean(s.local), resume: true, signal })));
    results.push(...batch);
    if (batch.some(x => x.status === "paused" || x.status === "blocked")) {
      console.log("任务再次暂停或阻塞；停止后续恢复，不自动重试模型调用。");
      break;
    }
  }
  return results;
}
