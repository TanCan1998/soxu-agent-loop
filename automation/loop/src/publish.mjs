import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./process.mjs";
import { ROOT, policy } from "./config.mjs";

const fail = (message, status = 409, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const git = async (execute, ...args) => (await execute("git", args, { cwd: ROOT, timeoutMs: 60_000 })).stdout.trim();
const pkgVersion = async () => JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;

/**
 * 发布前的现场信息：dev 是否已合入 main、本地检出状态、可用版本。
 * release 必须先满足 mergedIntoRelease，preview 只需要 dev 的 CI 通过。
 */
export async function publishStatus({ execute = run, root = ROOT } = {}) {
  const p = await policy();
  const integration = p.integrationBranch ?? "main";
  const release = p.releaseBranch ?? "main";
  try {
    await git(execute, "fetch", "--quiet", "--tags", "origin");
    const devTip = await git(execute, "rev-parse", "refs/remotes/origin/" + integration);
    const releaseTip = await git(execute, "rev-parse", "refs/remotes/origin/" + release);
    const ancestor = await execute("git", ["merge-base", "--is-ancestor", "refs/remotes/origin/" + integration, "refs/remotes/origin/" + release], { cwd: root, allowFailure: true, timeoutMs: 30_000 });
    const head = await git(execute, "rev-parse", "--abbrev-ref", "HEAD");
    const clean = (await git(execute, "status", "--porcelain")).length === 0;
    return {
      integrationBranch: integration, releaseBranch: release,
      integrationTip: devTip, releaseTip,
      mergedIntoRelease: ancestor.code === 0,
      head, clean,
      autoRelease: Boolean(p.autoRelease), channel: p.releaseChannel ?? null,
      version: await pkgVersion(),
    };
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 200) };
  }
}

async function assertCiGreen({ execute, branch, sha }) {
  const runs = JSON.parse((await execute("gh", ["run", "list", "--branch", branch, "--workflow", "ci.yml", "--limit", "30", "--json", "headSha,status,conclusion"], { cwd: ROOT, timeoutMs: 45_000 })).stdout);
  if (!runs.some(r => r.headSha === sha && r.status === "completed" && r.conclusion === "success"))
    throw fail("no-successful-ci-on-" + branch, 409);
}

/** preview：直接在集成分支上打预发布 tag，由 GitHub Actions 构建。 */
export async function publishPreview({ execute = run, version = null } = {}) {
  const status = await publishStatus({ execute });
  if (status.error) throw fail(status.error, 409);
  const base = version ?? status.version;
  if (!/^0\.\d+\.\d+$/.test(base)) throw fail("invalid-version", 400);
  await assertCiGreen({ execute, branch: status.integrationBranch, sha: status.integrationTip });
  const existing = await git(execute, "tag", "--list", "v" + base + "-rc.*");
  const next = existing.split(/\r?\n/).filter(Boolean).length + 1;
  const tag = "v" + base + "-rc." + next;
  await execute("gh", ["release", "create", tag, "--target", status.integrationBranch, "--prerelease", "--generate-notes", "--title", "SOXU preview " + tag], { cwd: ROOT, timeoutMs: 60_000 });
  return { status: "preview-published", tag, target: status.integrationBranch };
}

/** release：要求 dev 已合入 main、本地在 main 且干净，然后交给项目的受保护发布脚本。 */
export async function publishRelease({ execute = run } = {}) {
  const status = await publishStatus({ execute });
  if (status.error) throw fail(status.error, 409);
  if (!status.mergedIntoRelease)
    throw fail(status.integrationBranch + "-not-merged-into-" + status.releaseBranch, 409, { details: status });
  if (status.head !== status.releaseBranch) throw fail("checkout-" + status.releaseBranch + "-first", 409, { details: status });
  if (!status.clean) throw fail("worktree-dirty", 409, { details: status });
  if (!status.autoRelease) throw fail("auto-release-disabled", 409, { details: status });
  const out = await execute(process.execPath, ["scripts/release.mjs", status.version], { cwd: ROOT, timeoutMs: 120_000 });
  return { status: "release-tagged", tag: "v" + status.version, output: String(out.stdout ?? "").slice(-800) };
}

/** 统一入口：路由与参数校验。 */
export async function publish(mode, options = {}) {
  if (mode === "preview") return publishPreview(options);
  if (mode === "release") return publishRelease(options);
  throw fail("invalid-mode", 400);
}
