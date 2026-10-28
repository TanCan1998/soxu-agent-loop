import { test } from "node:test";
import assert from "node:assert/strict";
import { publish, publishRelease } from "../src/publish.mjs";

const ok = stdout => ({ code: 0, stdout, stderr: "" });
function stub({ merged = false, head = "main", dirty = "" } = {}) {
  return async (bin, args) => {
    if (bin === "git") {
      if (args[0] === "fetch") return ok("");
      if (args[0] === "merge-base") return { code: merged ? 0 : 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return ok(head + "\n");
      if (args[0] === "rev-parse") return ok("a".repeat(40) + "\n");
      if (args[0] === "status") return ok(dirty);
    }
    throw new Error("unexpected " + bin + " " + args.join(" "));
  };
}

test("an unknown publish mode is rejected before touching the repo", async () => {
  await assert.rejects(() => publish("bogus"), error => error.status === 400);
});

test("release is refused while the integration branch is not merged", async () => {
  await assert.rejects(
    () => publishRelease({ execute: stub({ merged: false }) }),
    error => error.status === 409 && /not-merged-into-main/.test(error.message),
  );
});

test("release is refused when the checkout is not on the release branch", async () => {
  await assert.rejects(
    () => publishRelease({ execute: stub({ merged: true, head: "dev" }) }),
    error => error.status === 409 && /checkout-main-first/.test(error.message),
  );
});

test("release is refused while autoRelease is disabled in policy", async () => {
  await assert.rejects(
    () => publishRelease({ execute: stub({ merged: true, head: "main", dirty: "" }) }),
    error => error.status === 409 && /auto-release-disabled/.test(error.message),
  );
});
