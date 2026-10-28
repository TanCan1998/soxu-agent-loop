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

/** 三个清单的版本必须一致，否则打错 tag 会让构建失败。 */
async function assertVersions(version) {
  const files = ["package.json", "apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json"];
  for (const file of files) {
    const json = JSON.parse(await readFile(join(ROOT, file), "utf8"));
    if (json.version !== version) throw fail("version-mismatch-" + file, 409, { expected: version, actual: json.version });
  }
}

/** dev 未合入 main 时先合并：人工点击即视为审核通过，无需 autoRelease 策略。 */
async function mergeIntegrationIntoRelease({ execute, status }) {
  if (status.mergedIntoRelease) return "already-merged";
  await git(execute, "fetch", "--quiet", "origin");
  await git(execute, "merge", "--ff-only", "refs/remotes/origin/" + status.releaseBranch);
  await git(execute, "merge", "--no-ff", "refs/remotes/origin/" + status.integrationBranch,
    "-m", "chore(release): merge " + status.integrationBranch + " into " + status.releaseBranch);
  await git(execute, "push", "origin", status.releaseBranch);
  return "merged";
}

/**
 * release：人工通道。点击即代表已人工审核，因此不受 autoRelease 限制；
 * 若 dev 尚未合入 main，先合并，再在 main 打 tag 触发 GitHub Actions 构建。
 */
export async function publishRelease({ execute = run } = {}) {
  const status = await publishStatus({ execute });
  if (status.error) throw fail(status.error, 409);
  if (status.head !== status.releaseBranch) throw fail("checkout-" + status.releaseBranch + "-first", 409, { details: status });
  if (!status.clean) throw fail("worktree-dirty", 409, { details: status });
  const merge = await mergeIntegrationIntoRelease({ execute, status });
  await assertVersions(status.version);
  const head = await git(execute, "rev-parse", "HEAD");
  await assertCiGreen({ execute, branch: status.releaseBranch, sha: head });
  const tag = "v" + status.version;
  if ((await git(execute, "tag", "--list", tag)).trim() === tag) throw fail("tag-exists", 409, { tag });
  await git(execute, "tag", "-a", tag, "-m", "SOXU " + tag + " release");
  await git(execute, "push", "origin", "refs/tags/" + tag);
  return {
    status: "release-published", tag,
    merge,
    from: status.integrationBranch, to: status.releaseBranch,
    note: "Tag pushed; GitHub Actions builds the release. Signing/notarisation still depends on configured secrets.",
  };
}

/** 统一入口：路由与参数校验。 */
export async function publish(mode, options = {}) {
  if (mode === "preview") return publishPreview(options);
  if (mode === "release") return publishRelease(options);
  throw fail("invalid-mode", 400);
}
