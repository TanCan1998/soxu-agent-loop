import { run } from "./process.mjs";

// Merge by exact head, then delete only the matching remote ref. Never delete a local worktree.
export async function mergeTaskPr(root, issue, prNumber, execute = run) {
  if (!Number.isSafeInteger(issue) || issue < 1 || !Number.isSafeInteger(prNumber) || prNumber < 1)
    throw Object.assign(new Error("invalid-pr"), {status:400});
  const opts = {cwd:root, timeoutMs:30000};
  const response = await execute("gh", ["pr", "view", String(prNumber), "--json", "number,state,isDraft,baseRefName,headRefName,headRefOid,isCrossRepository,body,statusCheckRollup,mergeable,reviewDecision"], opts);
  const pr = JSON.parse(response.stdout);
  const checks = pr.statusCheckRollup;
  const closes = new RegExp(`(?:^|\\n)\\s*(?:closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve)\\s+#${issue}\\b`, "im");
  const green = Array.isArray(checks) && checks.length > 0 && checks.every(c => ["SUCCESS","NEUTRAL","SKIPPED"].includes(c.conclusion) || c.state === "SUCCESS");
  if (pr.number !== prNumber || pr.state !== "OPEN" || pr.isDraft || pr.isCrossRepository || pr.baseRefName !== "main" || pr.mergeable !== "MERGEABLE" || pr.reviewDecision === "CHANGES_REQUESTED" || !closes.test(pr.body ?? "") || !green || !new RegExp(`^agent/(?:github-issue-|issue-)${issue}-[a-z0-9-]+$`).test(pr.headRefName ?? "") || !/^[0-9a-f]{40,64}$/.test(pr.headRefOid ?? ""))
    throw Object.assign(new Error("pr-not-ready"), {status:409});
  await execute("gh", ["pr", "merge", String(prNumber), "--squash", "--match-head-commit", pr.headRefOid], opts);
  try {
    await execute("git", ["push", `--force-with-lease=refs/heads/${pr.headRefName}:${pr.headRefOid}`, "origin", `:refs/heads/${pr.headRefName}`], opts);
    return {merged:true, branchDeleted:true};
  } catch { return {merged:true, branchDeleted:false, branch:pr.headRefName}; }
}
