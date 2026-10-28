import { test } from "node:test";
import assert from "node:assert/strict";
import { publish, publishRelease } from "../src/publish.mjs";

const ok = stdout => ({ code: 0, stdout, stderr: "" });
const sha = "a".repeat(40);
function stub({ merged = false, head = "main", dirty = "", tagExists = false, calls = [] } = {}) {
  return async (bin, args) => {
    calls.push(bin + " " + args.join(" "));
    if (bin === "git") {
      if (args[0] === "fetch") return ok("");
      if (args[0] === "merge-base") return { code: merged ? 0 : 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return ok(head + "\n");
      if (args[0] === "rev-parse") return ok(sha + "\n");
      if (args[0] === "status") return ok(dirty);
      if (args[0] === "merge" || args[0] === "push") return ok("");
      if (args[0] === "tag" && args[1] === "--list") return ok(tagExists ? "v0.1.0\n" : "");
      if (args[0] === "tag") return ok("");
    }
    if (bin === "gh") return ok(JSON.stringify([{ headSha: sha, status: "completed", conclusion: "success" }]));
    throw new Error("unexpected " + bin + " " + args.join(" "));
  };
}

test("an unknown publish mode is rejected before touching the repo", async () => {
  await assert.rejects(() => publish("bogus"), error => error.status === 400);
});

test("release is refused when the checkout is not on the release branch", async () => {
  await assert.rejects(() => publishRelease({ execute: stub({ head: "dev" }) }),
    error => error.status === 409 && /checkout-main-first/.test(error.message));
});

test("release is refused when the worktree is dirty", async () => {
  await assert.rejects(() => publishRelease({ execute: stub({ dirty: " M package.json\n" }) }),
    error => error.status === 409 && /worktree-dirty/.test(error.message));
});

test("a merged integration branch goes straight to tagging", async () => {
  const calls = [];
  const result = await publishRelease({ execute: stub({ merged: true, calls }) });
  assert.equal(result.status, "release-published");
  assert.equal(result.merge, "already-merged");
  assert.ok(calls.some(c => c.startsWith("git push origin refs/tags/")), calls.join(" | "));
  assert.ok(!calls.some(c => c.includes("--no-ff")), "no merge when already merged");
});

test("release merges the integration branch into main before tagging (no autoRelease gate)", async () => {
  const calls = [];
  const result = await publishRelease({ execute: stub({ merged: false, calls }) });
  assert.equal(result.status, "release-published");
  assert.equal(result.merge, "merged");
  assert.ok(calls.some(c => c.includes("merge --no-ff refs/remotes/origin/dev")), calls.join(" | "));
  assert.ok(calls.some(c => c === "git push origin main"), calls.join(" | "));
  assert.ok(calls.some(c => c.startsWith("git push origin refs/tags/")), calls.join(" | "));
});

test("an existing tag blocks a duplicate release", async () => {
  await assert.rejects(() => publishRelease({ execute: stub({ merged: true, tagExists: true }) }),
    error => error.status === 409 && /tag-exists/.test(error.message));
});
