import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./process.mjs";
import { ROOT, policy } from "./config.mjs";

const fail = (message, status = 409, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const git = async (execute, ...args) => (await execute("git", args, { cwd: ROOT, timeoutMs: 60_000 })).stdout.trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pkgVersion = async () => JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;

/** 轮询直到 fn 返回真值；超时抛出可诊断的错误，绝不静默继续。 */
async function waitUntil(fn, { deadline, intervalMs, label }) {
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw fail("timeout-waiting-for-" + label, 504, { details: last });
}

/** 发布前的现场信息：dev 是否已合入 main、本地检出状态、可用版本。 */
export async function publishStatus({ execute = run, root = ROOT } = {}) {
  const p = await policy();
  const integration = p.integrationBranch ?? "main";
  const release = p.releaseBranch ?? "main";
  try {
    await git(execute, "fetch", "--quiet", "--tags", "origin");
    const integrationTip = await git(execute, "rev-parse", "refs/remotes/origin/" + integration);
    const releaseTip = await git(execute, "rev-parse", "refs/remotes/origin/" + release);
    const ancestor = await execute("git", ["merge-base", "--is-ancestor", "refs/remotes/origin/" + integration, "refs/remotes/origin/" + release], { cwd: root, allowFailure: true, timeoutMs: 30_000 });
    const head = await git(execute, "rev-parse", "--abbrev-ref", "HEAD");
    const clean = (await git(execute, "status", "--porcelain")).length === 0;
    return {
      integrationBranch: integration, releaseBranch: release,
      integrationTip, releaseTip,
      mergedIntoRelease: ancestor.code === 0,
      head, clean,
      autoRelease: Boolean(p.autoRelease), channel: p.releaseChannel ?? null,
      version: await pkgVersion(),
      // release 走 PR：不再要求本地检出或工作区状态。
      releaseVia: "pull-request",
    };
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 200) };
  }
}

async function assertCiGreen({ execute, branch, sha, timeoutMs = 20 * 60_000, intervalMs = 15_000 }) {
  await waitUntil(async () => {
    const runs = JSON.parse((await execute("gh", ["run", "list", "--branch", branch, "--workflow", "ci.yml", "--limit", "30", "--json", "headSha,status,conclusion"], { cwd: ROOT, timeoutMs: 45_000 })).stdout);
    const run = runs.find(r => r.headSha === sha);
    if (!run) return null;
    if (run.status === "completed") {
      if (run.conclusion !== "success") throw fail("ci-not-successful-on-" + branch + ":" + run.conclusion, 409);
      return { sha, conclusion: run.conclusion };
    }
    return null;
  }, { deadline: Date.now() + timeoutMs, intervalMs, label: "CI on " + branch });
}

/** 以 release 分支上的提交为准读取版本，避免本地检出过期导致打错 tag。 */
async function releaseVersion(execute, sha) {
  const remote = async path => JSON.parse((await execute("git", ["show", sha + ":" + path], { cwd: ROOT, timeoutMs: 30_000 })).stdout);
  const pkg = await remote("package.json");
  if (!/^0\.\d+\.\d+$/.test(String(pkg.version))) throw fail("invalid-version", 409, { actual: pkg.version });
  for (const file of ["apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json"]) {
    const json = await remote(file);
    if (json.version !== pkg.version) throw fail("version-mismatch-" + file, 409, { expected: pkg.version, actual: json.version });
  }
  return pkg.version;
}

/**
 * 人工通道：dev → main 走 PR，等必需检查通过后合并，再在 main 打 tag。
 * 点击即代表人工已审核，因此不经过 autoRelease（该策略只约束自动发布通道）。
 */
export async function publishRelease({ execute = run, timeoutMs = 20 * 60_000, intervalMs = 15_000 } = {}) {
  const status = await publishStatus({ execute });
  if (status.error) throw fail(status.error, 409);
  const deadline = Date.now() + timeoutMs;
  let merge = "already-merged";
  if (!status.mergedIntoRelease) {
    const open = JSON.parse((await execute("gh", ["pr", "list", "--base", status.releaseBranch, "--head", status.integrationBranch, "--state", "open", "--json", "number", "--limit", "1"], { cwd: ROOT, timeoutMs: 45_000 })).stdout);
    let number = open[0]?.number;
    if (!number) {
      const created = await execute("gh", ["pr", "create", "--base", status.releaseBranch, "--head", status.integrationBranch,
        "--title", "chore(release): merge " + status.integrationBranch + " into " + status.releaseBranch,
        "--body", "人工触发的 release 合并：把已验证的 " + status.integrationBranch + " 合入 " + status.releaseBranch + "。合并后由发布按钮打 tag。"], { cwd: ROOT, timeoutMs: 60_000 });
      number = Number(String(created.stdout).trim().match(/\/pull\/(\d+)/)?.[1]);
      if (!Number.isInteger(number)) throw fail("pr-create-unknown", 502, { output: String(created.stdout).slice(0, 200) });
    }
    await waitUntil(async () => {
      const pr = JSON.parse((await execute("gh", ["pr", "view", String(number), "--json", "mergeStateStatus,statusCheckRollup"], { cwd: ROOT, timeoutMs: 45_000 })).stdout);
      if (pr.mergeStateStatus === "CLEAN") return { number, state: pr.mergeStateStatus };
      const pending = (pr.statusCheckRollup ?? []).filter(check => check.status && check.status !== "COMPLETED");
      // 明确失败态且没有待跑检查时不再空等。
      if (["DIRTY", "BLOCKED", "UNSTABLE"].includes(pr.mergeStateStatus) && !pending.length) throw fail("pr-not-clean-" + pr.mergeStateStatus, 409, { details: { number, checks: pr.statusCheckRollup ?? [] } });
      return null;
    }, { deadline, intervalMs, label: "PR #" + number + " checks" });
    await execute("gh", ["pr", "merge", String(number), "--merge"], { cwd: ROOT, timeoutMs: 60_000 });
    merge = "merged-via-pr#" + number;
  }
  const releaseSha = await git(execute, "rev-parse", "refs/remotes/origin/" + status.releaseBranch);
  const version = await releaseVersion(execute, releaseSha);
  await assertCiGreen({ execute, branch: status.releaseBranch, sha: releaseSha, timeoutMs, intervalMs });
  const tag = "v" + version;
  if ((await git(execute, "tag", "--list", tag)).trim() === tag) throw fail("tag-exists", 409, { tag });
  await git(execute, "tag", "-a", tag, releaseSha, "-m", "SOXU " + tag + " release");
  await git(execute, "push", "origin", "refs/tags/" + tag);
  return {
    status: "release-published", tag, sha: releaseSha, merge,
    from: status.integrationBranch, to: status.releaseBranch, via: "pull-request",
    note: "Tag pushed; GitHub Actions builds the release. Signing/notarisation still depends on configured secrets.",
  };
}

/** preview：直接在集成分支打预发布 tag，由 GitHub Actions 构建。 */
export async function publishPreview({ execute = run, version = null, timeoutMs = 10 * 60_000, intervalMs = 15_000 } = {}) {
  const status = await publishStatus({ execute });
  if (status.error) throw fail(status.error, 409);
  const base = version ?? status.version;
  if (!/^0\.\d+\.\d+$/.test(base)) throw fail("invalid-version", 400);
  await assertCiGreen({ execute, branch: status.integrationBranch, sha: status.integrationTip, timeoutMs, intervalMs });
  const existing = await git(execute, "tag", "--list", "v" + base + "-rc.*");
  const next = existing.split(/\r?\n/).filter(Boolean).length + 1;
  const tag = "v" + base + "-rc." + next;
  await execute("gh", ["release", "create", tag, "--target", status.integrationBranch, "--prerelease", "--generate-notes", "--title", "SOXU preview " + tag], { cwd: ROOT, timeoutMs: 60_000 });
  return { status: "preview-published", tag, target: status.integrationBranch };
}

/** 统一入口：路由与参数校验。 */
export async function publish(mode, options = {}) {
  if (mode === "preview") return publishPreview(options);
  if (mode === "release") return publishRelease(options);
  throw fail("invalid-mode", 400);
}
