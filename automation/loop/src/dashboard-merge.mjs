import { run } from "./process.mjs";
import { closesIssue, issueFromBranch } from "./rules.mjs";

// Merge by exact head, then delete only the matching remote ref. Never delete a local worktree.
export async function mergeTaskPr(root, issue, prNumber, execute = run, base = "main") {
  if (!Number.isSafeInteger(issue) || issue < 1 || !Number.isSafeInteger(prNumber) || prNumber < 1)
    throw Object.assign(new Error("invalid-pr"), {status:400});
  const opts = {cwd:root, timeoutMs:30000};
  const response = await execute("gh", ["pr", "view", String(prNumber), "--json", "number,state,isDraft,baseRefName,headRefName,headRefOid,isCrossRepository,body,statusCheckRollup,mergeable,reviewDecision"], opts);
  const pr = JSON.parse(response.stdout);
  const checks = pr.statusCheckRollup;
  // 关闭引用与分支命名都来自 rules.mjs：合并前的最后一道校验不能有第二份正则。
  const closes = closesIssue(pr.body, issue);
  const branch = issueFromBranch(pr.headRefName);
  const green = Array.isArray(checks) && checks.length > 0 && checks.every(c => ["SUCCESS","NEUTRAL","SKIPPED"].includes(c.conclusion) || c.state === "SUCCESS");
  if (pr.number !== prNumber || pr.state !== "OPEN" || pr.isDraft || pr.isCrossRepository || pr.baseRefName !== base || pr.mergeable !== "MERGEABLE" || pr.reviewDecision === "CHANGES_REQUESTED" || !closes || !green || branch?.issue !== issue || !/^[0-9a-f]{40,64}$/.test(pr.headRefOid ?? ""))
    throw Object.assign(new Error("pr-not-ready"), {status:409});
  await execute("gh", ["pr", "merge", String(prNumber), "--squash", "--match-head-commit", pr.headRefOid], opts);
  try {
    await execute("git", ["push", `--force-with-lease=refs/heads/${pr.headRefName}:${pr.headRefOid}`, "origin", `:refs/heads/${pr.headRefName}`], opts);
    return {merged:true, branchDeleted:true};
  } catch { return {merged:true, branchDeleted:false, branch:pr.headRefName}; }
}
