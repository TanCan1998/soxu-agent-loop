/**
 * 任务工作树与锁：领取锁、创建/复用分支与 worktree、跑项目检查命令。
 *
 * 从 worker.mjs 拆出（2026-11-02）。这里只关心「文件系统与 Git 状态」，
 * 不涉及模型调用，因此可以独立测试与复用。
 */
import { open, readFile, rm, mkdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ROOT } from "./config.mjs";
import { git, run } from "./process.mjs";
import { slug } from "./guards.mjs";

export const WORKTREES = resolve(ROOT, "../soxu-worktrees");
export const LOCKS = resolve(ROOT, ".soxu", "locks");
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
export async function acquire(issueId, local) {
  await mkdir(LOCKS, { recursive: true });
  const path = join(LOCKS, `${local ? "local" : "github"}-issue-${issueId}.lock`);
  let handle;
  try { handle = await open(path, "wx"); }
  catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Only recover orphaned locks; never interfere with a live coordinator.
    let info;
    try { info = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error(`Unreadable lock ${path}; investigate manually`); }
    if (!Number.isInteger(info.pid) || info.pid < 1) throw new Error(`Invalid lock ${path}; investigate manually`);
    try { process.kill(info.pid, 0); throw new Error(`Task #${issueId} is already owned by PID ${info.pid}`); }
    catch (e) { if (e.code !== "ESRCH") throw e; }
    await rm(path); // verified dead PID; keep Worktree and checkpoint
    handle = await open(path, "wx");
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  await handle.close();
  return async () => rm(path, { force: true });
}

export async function worktreeFor(issue, local, state, base = "main") {
  if (state.directory) {
    // Never trust a recovered JSON path to point outside the managed worktree root.
    if (!resolve(state.directory).startsWith(WORKTREES + (process.platform === "win32" ? "\\" : "/"))) throw new Error("Saved Worktree path outside managed directory");
    if (!state.branch?.startsWith(`agent/${local ? "local" : "github"}-issue-${issue.number}-`) && !state.branch?.startsWith(`agent/issue-${issue.number}-`)) throw new Error("Saved branch mismatch");
    const root = await git(["rev-parse", "--show-toplevel"], state.directory);
    const branch = await git(["branch", "--show-current"], state.directory);
    if (!samePath(await realpath(root),await realpath(state.directory)) || branch !== state.branch) throw new Error("Saved Worktree identity mismatch; manual inspection required");
    return { branch, directory: state.directory };
  }
  await mkdir(WORKTREES, { recursive: true });
  const branch = `agent/${local ? "local" : "github"}-issue-${issue.number}-${slug(issue.title)}`;
  const directory = join(WORKTREES, `${local ? "local" : "github"}-issue-${issue.number}-${slug(issue.title)}`);
  if (!local) await git(["fetch", "origin", base], ROOT);
  // 幂等准备：中断或人工清理后常留下两种残骸，历史上都会让任务直接 blocked——
  //   1) 目录在但 .git 已被删 → 旧代码 stat 成功就跳过创建，随后 git branch 报 not a git repository
  //   2) 分支在但 worktree 没了 → worktree add -b 报 branch already exists
  let dirExists = false;
  try { await stat(directory); dirExists = true; }
  catch (err) { if (err.code !== "ENOENT") throw err; }
  let dirReady = false;
  if (dirExists) {
    try {
      const top = await git(["rev-parse", "--show-toplevel"], directory);
      dirReady = samePath(await realpath(top), await realpath(directory));
    } catch { dirReady = false; }
    if (!dirReady) {
      console.warn(`Removing stale worktree directory (no .git): ${directory}`);
      await rm(directory, { recursive: true, force: true });
    }
  }
  let branchReady = false;
  try { await git(["rev-parse", "--verify", "refs/heads/" + branch], ROOT); branchReady = true; }
  catch { branchReady = false; }
  if (branchReady && !dirReady) {
    // 分支残留：只有它相对集成分支没有独有提交时才删除重建，避免丢掉未推送的工作。
    let ahead = "0";
    try { ahead = (await git(["rev-list", "--count", `${local ? base : "origin/" + base}..${branch}`], ROOT)).trim(); }
    catch { ahead = "0"; }
    if (Number(ahead) === 0) {
      console.warn(`Removing stale branch (no unique commits): ${branch}`);
      await git(["branch", "-D", branch], ROOT);
      branchReady = false;
    }
  }
  if (!dirReady) {
    const addArgs = branchReady
      ? ["worktree", "add", directory, branch]
      : ["worktree", "add", "-b", branch, directory, local ? base : "origin/" + base];
    await git(addArgs, ROOT);
  }
  // rerere：记录冲突解决，重复冲突自动复用（同一插入点会反复冲突，见 docs/loop-robustness-plan.md）。
  // 只作起点——复用的结果仍要经过 checks 与 review 验证。
  await git(["config", "rerere.enabled", "true"], directory).catch(() => {});
  await git(["config", "rerere.autoupdate", "true"], directory).catch(() => {});
  const foundBranch = await git(["branch", "--show-current"], directory);
  if (foundBranch !== branch) throw new Error("Worktree already exists but belongs to another branch");
  return { branch, directory };
}

export async function runChecks(cwd, policy, signal) {
  for (const check of policy.checks) {
    console.log(`gate: ${check.bin} ${check.args.join(" ")}`);
    await run(check.bin, check.args, { cwd, timeoutMs: check.timeoutMinutes * 60_000, signal });
  }
}
// 按角色注入相关策略子集：agents/policies/*.md 里的规则过去从未进入 Agent 上下文，
// 导致 git-workflow.md 明写的「开发 Agent 只改文件」形同不存在（Issue #97 因此直接提交）。
