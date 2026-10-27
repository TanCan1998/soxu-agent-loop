import { git } from "./process.mjs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

export function isProtected(file, protectedPaths) {
  const norm = file.replaceAll("\\", "/");
  return protectedPaths.some(p => norm.toLowerCase() === p.toLowerCase() || p.endsWith("/") && norm.toLowerCase().startsWith(p.toLowerCase()));
}
export function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 35) || "task"; }
export function validIssue(issue) { return Number.isInteger(issue.number) && issue.number > 0 && issue.number < 1e9; }

export async function inspectChanges(cwd, base, policy) {
  if (await git(["rev-parse", "HEAD"], cwd) !== base) throw new Error("Agent changed Git HEAD/committed directly");
  const modified = (await git(["diff", "--name-only", "-z", "HEAD"], cwd)).split("\0").filter(Boolean);
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
  await git(["diff", "--cached", "--check"], cwd);
  return paths;
}
