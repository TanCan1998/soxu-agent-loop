/**
 * PR 生命周期：读取合并状态、等待合并、冲突恢复。
 *
 * 从 worker.mjs 拆出（2026-11-02）。`gh pr merge --auto` 只是「请求自动合并」，
 * 这些函数负责把「请求」变成「确认」。
 */
import { ROOT } from "./config.mjs";
import { git, run } from "./process.mjs";
import { LoopFailure } from "./errors.mjs";
export async function inspectPr(prUrl) {
  const { stdout } = await run("gh", ["pr", "view", prUrl,
    "--json", "state,mergeable,mergeStateStatus,mergedAt,mergeCommit,headRefName,baseRefName"],
    { cwd: ROOT, timeoutMs: 45000 });
  return JSON.parse(stdout);
}

/**
 * 等待 PR 真正合并。
 *
 * 历史缺陷（2026-10-29 实测）：merge 阶段请求自动合并后直接写 done，
 * 冲突的 PR 无人重试，issue 卡在 agent:pr 永不关闭，需要人工 rebase。
 * 现在必须轮询到 MERGED 才允许进入 done；冲突/关闭立刻抛 LoopFailure。
 */
export async function waitForMerged(prUrl, { policy, signal }) {
  const limitMs = (policy.timeouts?.autoMergeMinutes ?? 20) * 60000;
  const deadline = Date.now() + limitMs;
  let last = "";
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new LoopFailure("interrupted", "等待合并时被中断");
    const info = await inspectPr(prUrl);
    const line = info.state + "/" + (info.mergeable ?? "-") + "/" + (info.mergeStateStatus ?? "-");
    if (line !== last) { console.log(`PR state: ${line}`); last = line; }
    if (info.state === "MERGED") return true;
    if (info.state === "CLOSED") throw new LoopFailure("merge", "PR 在等待合并期间被关闭：" + prUrl);
    if (info.mergeable === "CONFLICTING" || info.mergeStateStatus === "DIRTY") {
      throw new LoopFailure("merge", "PR 在等待合并期间变为冲突（mergeable=CONFLICTING）：" + prUrl);
    }
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  return false;
}

/**
 * PR 与集成分支冲突时的自动恢复。
 *
 * 借鉴 Factory《Merge conflict resolution with coding agents》的流程：
 * 固定 base、按类型分类处理、保持解决范围窄、不可解则停下报告。
 *
 * 返回：
 *   { status: "rebased" }                      已自动 rebase（无冲突或 lockfile 自动处理）
 *   { status: "delegated", files, blockCount } 冲突规模可控，保留现场交 Developer 解决
 *   { status: "manual", files, blockCount }    冲突过大，abort 并交人工
 *   { status: "failed", reason }               rebase 本身失败且无冲突文件
 */
export async function attemptConflictRecovery({ directory, base, policy, signal }) {
  const gitOpts = { cwd: directory, timeoutMs: 180000, signal, allowFailure: true };
  await git(["fetch", "origin", base], directory);
  const rebase = await run("git", ["rebase", "origin/" + base], gitOpts);
  if (rebase.exitCode === 0) return { status: "rebased" };

  const unmerged = await run("git", ["diff", "--name-only", "--diff-filter=U"], gitOpts);
  const files = String(unmerged.stdout ?? "").split("\n").map(x => x.trim()).filter(Boolean);
  if (!files.length) {
    await run("git", ["rebase", "--abort"], gitOpts);
    return { status: "failed", reason: safeFailureMessage(rebase.stderr || "rebase failed", 300) };
  }

  // lockfile 冲突：取 base 版本后重新生成，不做逐行合并（Factory 的做法）。
  const lockfiles = files.filter(f => /(Cargo\.lock|pnpm-lock\.yaml|package-lock\.json)$/.test(f));
  if (lockfiles.length === files.length) {
    for (const f of lockfiles) await run("git", ["checkout", "--theirs", "--", f], gitOpts);
    await run("git", ["add", "--", ...lockfiles], gitOpts);
    const cont = await run("git", ["rebase", "--continue"], { ...gitOpts, env: { ...process.env, GIT_EDITOR: "true" } });
    if (cont.exitCode === 0) {
      console.log("Resolved lockfile-only conflict by taking base versions");
      return { status: "rebased" };
    }
  }

  // 统计冲突块，判断是否超出 agent 可靠处理的范围。
  let blockCount = 0;
  for (const f of files) {
    try {
      const content = await readFile(join(directory, f), "utf8");
      blockCount += (content.match(/^<<<<<<< /gm) ?? []).length;
    } catch { /* 二进制或已删除文件 */ }
  }
  const maxFiles = policy.recovery?.maxConflictFiles ?? 3;
  const maxBlocks = policy.recovery?.maxConflictBlocks ?? 8;
  if (files.length > maxFiles || blockCount > maxBlocks) {
    await run("git", ["rebase", "--abort"], gitOpts);
    return { status: "manual", files, blockCount };
  }
  // 保留冲突现场：Developer 在 develop 阶段接手解决。
  return { status: "delegated", files, blockCount };
}

