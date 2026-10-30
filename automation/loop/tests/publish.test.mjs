import { test } from "node:test";
import assert from "node:assert/strict";
import { publish, publishRelease, publishPreview } from "../src/publish.mjs";

const ok = stdout => ({ code: 0, stdout, stderr: "" });
const sha = ch => ch.repeat(40);
const pkg = version => JSON.stringify({ name: "soxu", version });
const cargo = version => `[package]\nname = "soxu-desktop"\nversion = "${version}"\nedition = "2024"\n\n[dependencies]\nserde = { version = "0.9.9" }\n`;

/**
 * versions 允许逐个清单指定版本，用来模拟版本不一致；
 * mergedSha 模拟 PR 合并后 origin/main 前进——只有合并之后的显式 fetch 才能看到新 sha。
 */
function stub({ merged = false, prNumber = 42, prState = "CLEAN", tagExists = false, versions = {}, existingPr = false, mergedSha = null, calls = [] } = {}) {
  const versionOf = key => versions[key] ?? versions.root ?? "0.1.0";
  let releaseTip = sha("b");
  return async (bin, args) => {
    calls.push(bin + " " + args.join(" "));
    if (bin === "git") {
      const line = args.join(" ");
      if (args[0] === "fetch") {
        // publishStatus 的 fetch 带 --tags；合并后的刷新用显式 refspec，能看到前进后的 tip。
        if (!args.includes("--tags") && mergedSha) releaseTip = mergedSha;
        return ok("");
      }
      if (args[0] === "merge-base") return { code: merged ? 0 : 1, stdout: "", stderr: "" };
      if (line.startsWith("rev-parse --abbrev-ref")) return ok("dev\n");
      if (line.startsWith("rev-parse refs/remotes/origin/dev")) return ok(sha("c") + "\n");
      if (line.startsWith("rev-parse refs/remotes/origin/main")) return ok(releaseTip + "\n");
      if (args[0] === "status") return ok("");
      if (args[0] === "show") {
        const path = args[1].split(":").slice(1).join(":");
        if (path.endsWith("Cargo.toml")) return ok(cargo(versionOf("cargo")));
        if (path === "apps/desktop/src-tauri/tauri.conf.json") return ok(pkg(versionOf("tauri")));
        if (path === "apps/desktop/package.json") return ok(pkg(versionOf("desktop")));
        return ok(pkg(versionOf("root")));
      }
      if (args[0] === "tag" && args[1] === "--list") return ok(tagExists ? "v0.1.0\n" : "");
      if (args[0] === "tag" || args[0] === "push") return ok("");
    }
    if (bin === "gh") {
      const line = args.join(" ");
      if (line.startsWith("pr list")) return ok(JSON.stringify(existingPr ? [{ number: prNumber }] : []));
      if (line.startsWith("pr create")) return ok("https://github.com/TanCan1998/SOXU/pull/" + prNumber + "\n");
      if (line.startsWith("pr view")) return ok(JSON.stringify({ mergeStateStatus: prState, statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }));
      if (line.startsWith("pr merge")) return ok("");
      if (line.startsWith("release create")) return ok("");
      if (line.startsWith("run list")) {
        const runs = [{ headSha: sha("b"), status: "completed", conclusion: "success" }, { headSha: sha("c"), status: "completed", conclusion: "success" }];
        if (mergedSha) runs.push({ headSha: mergedSha, status: "completed", conclusion: "success" });
        return ok(JSON.stringify(runs));
      }
    }
    throw new Error("unexpected " + bin + " " + args.join(" "));
  };
}
const fast = { timeoutMs: 3_000, intervalMs: 1 };

test("an unknown publish mode is rejected before touching the repo", async () => {
  await assert.rejects(() => publish("bogus"), error => error.status === 400);
});

test("release without a prior merge opens a dev->main PR, waits for checks, then merges and tags", async () => {
  const calls = [];
  const result = await publishRelease({ execute: stub({ merged: false, mergedSha: sha("d"), calls }), ...fast });
  assert.equal(result.status, "release-published");
  assert.equal(result.merge, "merged-via-pr#42");
  assert.equal(result.via, "pull-request");
  assert.ok(calls.some(c => c.startsWith("gh pr create --base main --head dev")), calls.join(" | "));
  assert.ok(calls.includes("gh pr merge 42 --merge"), calls.join(" | "));
  // 合并后必须重新 fetch 再取 sha，否则 tag 会落在合并前的 main 上。
  assert.ok(calls.indexOf("gh pr merge 42 --merge") < calls.indexOf("git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main"), calls.join(" | "));
  assert.equal(result.sha, sha("d"));
});

test("release tags the merge commit instead of the stale pre-merge main tip", async () => {
  const calls = [];
  const result = await publishRelease({ execute: stub({ merged: false, mergedSha: sha("d"), calls }), ...fast });
  assert.equal(result.merge, "merged-via-pr#42");
  assert.equal(result.sha, sha("d"));
  assert.ok(calls.some(c => c === "git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main"), calls.join(" | "));
  assert.ok(calls.includes("git tag -a v0.1.0 " + sha("d") + " -m SOXU v0.1.0 release"), calls.join(" | "));
  assert.ok(calls.includes("git push origin refs/tags/v0.1.0"), calls.join(" | "));
  // 关键顺序：先打 tag 再推送，且绝不直接 push main。
  assert.ok(!calls.includes("git push origin main"), "release must not push main directly anymore");
});

test("a release fails closed when origin/<release> never advances after the merge", async () => {
  await assert.rejects(
    () => publishRelease({ execute: stub({ merged: false }), timeoutMs: 300, intervalMs: 50 }),
    error => error.status === 504 && /timeout-waiting-for-origin\/main to advance/.test(error.message));
});

test("an existing release PR is reused instead of opening a second one", async () => {
  const calls = [];
  const result = await publishRelease({ execute: stub({ existingPr: true, mergedSha: sha("d"), calls }), ...fast });
  assert.equal(result.merge, "merged-via-pr#42");
  assert.ok(!calls.some(c => c.startsWith("gh pr create")), "must not open a duplicate PR: " + calls.join(" | "));
  assert.ok(calls.includes("gh pr merge 42 --merge"));
});

test("an already merged integration branch skips the PR and tags the release tip", async () => {
  const calls = [];
  const result = await publishRelease({ execute: stub({ merged: true, calls }), ...fast });
  assert.equal(result.merge, "already-merged");
  assert.equal(result.sha, sha("b"));
  assert.ok(!calls.some(c => c.startsWith("gh pr")), "no PR when already merged: " + calls.join(" | "));
  assert.ok(calls.includes("git push origin refs/tags/v0.1.0"));
});

test("a blocked PR stops the release instead of waiting forever", async () => {
  await assert.rejects(() => publishRelease({ execute: stub({ merged: false, prState: "DIRTY" }), ...fast }),
    error => error.status === 409 && /pr-not-clean-DIRTY/.test(error.message));
});

test("an existing tag blocks a duplicate release", async () => {
  await assert.rejects(() => publishRelease({ execute: stub({ merged: true, tagExists: true }), ...fast }),
    error => error.status === 409 && /tag-exists/.test(error.message));
});

test("a version mismatch between manifests blocks the release", async () => {
  await assert.rejects(() => publishRelease({ execute: stub({ merged: true, versions: { desktop: "0.2.0" } }), ...fast }),
    error => error.status === 409 && /version-mismatch-apps\/desktop\/package\.json/.test(error.message));
});

test("a Cargo.toml version mismatch blocks both channels", async () => {
  await assert.rejects(() => publishRelease({ execute: stub({ merged: true, versions: { cargo: "0.2.0" } }), ...fast }),
    error => error.status === 409 && error.message === "version-mismatch-apps/desktop/src-tauri/Cargo.toml");
  await assert.rejects(() => publishPreview({ execute: stub({ versions: { cargo: "0.2.0" } }), ...fast }),
    error => error.status === 409 && error.message === "version-mismatch-apps/desktop/src-tauri/Cargo.toml");
});

test("preview publishes a prerelease on the integration branch", async () => {
  const calls = [];
  const result = await publishPreview({ execute: stub({ calls }), ...fast });
  assert.equal(result.status, "preview-published");
  assert.equal(result.target, "dev");
  assert.match(result.tag, /^v0\.\d+\.\d+-rc\.1$/);
  assert.ok(calls.some(c => c.includes("release create " + result.tag + " --target dev --prerelease")), calls.join(" | "));
});

test("preview takes its version from the integration tip, not the local checkout", async () => {
  const calls = [];
  const result = await publishPreview({ execute: stub({ versions: { root: "0.2.0" }, calls }), ...fast });
  assert.equal(result.tag, "v0.2.0-rc.1");
  assert.ok(calls.some(c => c.startsWith("git show " + sha("c") + ":package.json")), calls.join(" | "));
});
