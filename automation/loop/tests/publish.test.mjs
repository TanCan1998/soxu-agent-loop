import { test } from "node:test";
import assert from "node:assert/strict";
import { publish, publishRelease, publishPreview } from "../src/publish.mjs";

const ok = stdout => ({ code: 0, stdout, stderr: "" });
const sha = ch => ch.repeat(40);
const pkg = version => JSON.stringify({ name: "soxu", version });

function stub({ merged = false, prNumber = 42, prState = "CLEAN", tagExists = false, desktopVersion = "0.1.0", existingPr = false, calls = [] } = {}) {
  return async (bin, args) => {
    calls.push(bin + " " + args.join(" "));
    if (bin === "git") {
      const line = args.join(" ");
      if (args[0] === "fetch") return ok("");
      if (args[0] === "merge-base") return { code: merged ? 0 : 1, stdout: "", stderr: "" };
      if (line.startsWith("rev-parse --abbrev-ref")) return ok("dev\n");
      if (line.startsWith("rev-parse refs/remotes/origin/dev")) return ok(sha("c") + "\n");
      if (line.startsWith("rev-parse refs/remotes/origin/main")) return ok(sha("b") + "\n");
      if (args[0] === "status") return ok("");
      if (args[0] === "show") {
        const path = args[1].split(":").slice(1).join(":");
        if (path === "apps/desktop/package.json") return ok(pkg(desktopVersion));
        return ok(pkg("0.1.0"));
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
      if (line.startsWith("run list"))
        return ok(JSON.stringify([{ headSha: sha("b"), status: "completed", conclusion: "success" }, { headSha: sha("c"), status: "completed", conclusion: "success" }]));
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
  const result = await publishRelease({ execute: stub({ merged: false, calls }), ...fast });
  assert.equal(result.status, "release-published");
  assert.equal(result.merge, "merged-via-pr#42");
  assert.equal(result.via, "pull-request");
  assert.ok(calls.some(c => c === "gh pr create --base main --head dev" || c.startsWith("gh pr create --base main --head dev")), calls.join(" | "));
  assert.ok(calls.includes("gh pr merge 42 --merge"), calls.join(" | "));
  assert.ok(calls.includes("git tag -a v0.1.0 " + sha("b") + " -m SOXU v0.1.0 release"), calls.join(" | "));
  assert.ok(calls.includes("git push origin refs/tags/v0.1.0"), calls.join(" | "));
  // 关键顺序：先打 tag 再推送，且绝不直接 push main。
  assert.ok(!calls.includes("git push origin main"), "release must not push main directly anymore");
});

test("an existing release PR is reused instead of opening a second one", async () => {
  const calls = [];
  const result = await publishRelease({ execute: stub({ existingPr: true, calls }), ...fast });
  assert.equal(result.merge, "merged-via-pr#42");
  assert.ok(!calls.some(c => c.startsWith("gh pr create")), "must not open a duplicate PR: " + calls.join(" | "));
  assert.ok(calls.includes("gh pr merge 42 --merge"));
});

test("an already merged integration branch skips the PR and tags the release tip", async () => {
  const calls = [];
  const result = await publishRelease({ execute: stub({ merged: true, calls }), ...fast });
  assert.equal(result.merge, "already-merged");
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
  await assert.rejects(() => publishRelease({ execute: stub({ merged: true, desktopVersion: "0.2.0" }), ...fast }),
    error => error.status === 409 && /version-mismatch-apps\/desktop\/package\.json/.test(error.message));
});

test("preview publishes a prerelease on the integration branch", async () => {
  const calls = [];
  const result = await publishPreview({ execute: stub({ calls }), ...fast });
  assert.equal(result.status, "preview-published");
  assert.equal(result.target, "dev");
  assert.match(result.tag, /^v0\.\d+\.\d+-rc\.1$/);
  assert.ok(calls.some(c => c.includes("release create " + result.tag + " --target dev --prerelease")), calls.join(" | "));
});
