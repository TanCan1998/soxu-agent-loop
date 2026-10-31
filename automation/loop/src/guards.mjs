import { git } from "./process.mjs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function isProtected(file, protectedPaths) {
  const norm = file.replaceAll("\\", "/");
  return protectedPaths.some(p => norm.toLowerCase() === p.toLowerCase() || p.endsWith("/") && norm.toLowerCase().startsWith(p.toLowerCase()));
}
export function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 35) || "task"; }
export function validIssue(issue) { return Number.isInteger(issue.number) && issue.number > 0 && issue.number < 1e9; }

export async function inspectChanges(cwd, base, policy) {
  // 恢复提交场景（2026-10-29）：被"不得直接 commit"闸拦下的任务会留下一个
  // parent === base 的提交（worker 恢复路径已认回 state.commit）。此时改动的
  // 正确基准是 base 而不是 HEAD：把已提交内容纳入同样的预算与保护路径检查。
  const head = await git(["rev-parse", "HEAD"], cwd);
  if (head !== base) {
    const parent = await git(["rev-parse", "HEAD^"], cwd).catch(() => null);
    if (parent !== base) throw new Error("Agent changed Git HEAD/committed directly");
  }
  const diffBase = head === base ? "HEAD" : base;
  const modified = (await git(["diff", "--name-only", "-z", diffBase], cwd)).split("\0").filter(Boolean);
  const staged = (await git(["diff", "--cached", "--name-only", "-z"], cwd)).split("\0").filter(Boolean);
  const added = (await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd)).split("\0").filter(Boolean);
  const paths = [...new Set([...modified, ...staged, ...added])];
  if (paths.length === 0 || paths.every(x => x === "pnpm-lock.yaml" || x === "Cargo.lock")) throw new Error("Agent produced no task changes");
  if (paths.length > policy.maxChangedFiles) throw new Error("Too many changed files");
  for (const file of paths) {
    if (isProtected(file, policy.protectedPaths)) throw new Error(`Protected path changed: ${file}`);
    if (/^(\.env($|\.)|.*\.(pem|key|p12|pfx)$)/i.test(file)) throw new Error(`Secret-like filename: ${file}`);
  }
  // Reject symlink additions: their targets may escape the Worktree.
  for (const file of paths) {
    let info;
    try { info = await lstat(join(cwd, file)); }
    catch (err) { if (err.code !== "ENOENT") throw err; }
    if (info?.isSymbolicLink()) throw new Error(`Symbolic link changes are not permitted: ${file}`);
    if (info && !info.isFile()) throw new Error(`Non-regular file changed: ${file}`);
    if (info?.size > policy.maxChangedBytes) throw new Error(`Changed file exceeds byte budget: ${file}`);
  }
  await git(["add", "-A"], cwd);
  // Git numstat uses dash markers for binary changes; never let NaN bypass budgets.
  let totalBytes = 0;
  const numstat = await git(["diff", "--cached", "--numstat", "-z", "--no-renames"], cwd);
  const records = numstat.split("\0").filter(Boolean);
  for (const record of records) {
    const [added, removed, path] = record.split("\t");
    if (!path || isProtected(path, policy.protectedPaths)) throw new Error(`Invalid or protected staged path: ${path}`);
    if (added === "-" && removed === "-") {
      try { totalBytes += (await lstat(join(cwd, path))).size; }
      catch (err) { if (err.code !== "ENOENT") throw err; }
    } else {
      if (!/^\d+$/.test(added) || !/^\d+$/.test(removed)) throw new Error(`Invalid change accounting: ${path}`);
      totalBytes += (Number(added) + Number(removed)) * 10;
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes > policy.maxChangedBytes) throw new Error("Diff exceeds change byte budget");
  }
  const diff = await git(["diff", "--cached", "--unified=0"], cwd);
  if (/^\+.*(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{24,})/m.test(diff)) throw new Error("Potential secret detected in staged diff");
  try {
    await git(["diff", "--cached", "--check"], cwd);
  } catch (error) {
    // 行尾空白是 Agent 最常见的机械性失手（2026-10-31 TASK-037 因此连续暂停两次）。
    // 它完全可确定修复，且与代码语义无关，所以先自动清理再复查，而不是直接判失败。
    const fixed = await stripTrailingWhitespace(cwd, paths);
    if (!fixed.length) throw error;
    await git(["add", "--", ...fixed], cwd);
    await git(["diff", "--cached", "--check"], cwd);
  }
  return paths;
}

/**
 * 清理代码类文件的行尾空白（空格与制表符）。
 *
 * 只处理「删掉也不改变语义」的扩展名：
 * - Markdown 的两个行尾空格是**硬换行**，删掉会改变渲染，因此 .md 一律不动；
 * - 其它文本/代码文件的行尾空白没有语义，可以安全清理；
 * - 二进制或不可读文件直接跳过。
 */
const WHITESPACE_FIXABLE = /\.(?:m?js|cjs|jsx|ts|tsx|vue|json|jsonc|css|scss|less|rs|toml|ya?ml|sh|ps1)$/i;

export async function stripTrailingWhitespace(cwd, files) {
  const fixed = [];
  for (const file of files) {
    if (!WHITESPACE_FIXABLE.test(file)) continue;
    const target = join(cwd, file);
    let text;
    try { text = await readFile(target, "utf8"); } catch { continue; }
    const next = text.replace(/[ \t]+(\r?\n)/g, "$1").replace(/[ \t]+$/, "");
    if (next === text) continue;
    await writeFile(target, next, "utf8");
    fixed.push(file);
  }
  return fixed;
}
