import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQueueOrder, writeQueueOrder, sortByQueueOrder, doneTaskIds, setIssueReady } from "../src/queue-order.mjs";

const temp = () => mkdtemp(join(tmpdir(), "soxu-qorder-"));

test("queue order round-trips and de-duplicates", async () => {
  const root = await temp();
  try {
    assert.deepEqual(await readQueueOrder(root), [], "missing file reads as empty");
    const saved = await writeQueueOrder(root, [12, 7, 12, 0, -3, 9]);
    assert.deepEqual(saved, [12, 7, 9], "dedupes and drops invalid numbers");
    assert.deepEqual(await readQueueOrder(root), [12, 7, 9]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sortByQueueOrder puts unlisted items after the custom order", async () => {
  const items = [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }];
  assert.deepEqual(sortByQueueOrder(items, [3, 1]).map(x => x.number), [3, 1, 2, 4]);
  assert.deepEqual(sortByQueueOrder(items, []).map(x => x.number), [1, 2, 3, 4], "empty order keeps input order");
});

test("doneTaskIds reads archived task ids", async () => {
  const root = await temp();
  try {
    assert.equal(await doneTaskIds(root), null, "missing directory is reported as null");
    await mkdir(join(root, "tasks", "done"), { recursive: true });
    await writeFile(join(root, "tasks", "done", "TASK-007.md"), "# done");
    await writeFile(join(root, "tasks", "done", "README.md"), "# readme");
    const ids = await doneTaskIds(root);
    assert.deepEqual([...ids], ["TASK-007"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function ghStub({ state = "OPEN", body = "dependencies: [TASK-099]" } = {}) {
  const calls = [];
  const execute = async (bin, args) => {
    calls.push(bin + " " + args.join(" "));
    if (args[0] === "issue" && args[1] === "view") {
      return { stdout: JSON.stringify({ number: 42, title: "[M2] [ISSUE-42] 示例", body, labels: [], state }) };
    }
    return { stdout: "" };
  };
  return { execute, calls };
}

test("setIssueReady refuses while a dependency is not archived", async () => {
  const root = await temp();
  try {
    await mkdir(join(root, "tasks", "done"), { recursive: true });
    const { execute, calls } = ghStub({ body: "dependencies: [TASK-099]" });
    const result = await setIssueReady(root, 42, true, { execute });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["TASK-099"]);
    assert.ok(!calls.some(c => c.includes("--add-label")), "no label is applied when the check fails");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setIssueReady applies the label once dependencies are archived", async () => {
  const root = await temp();
  try {
    await mkdir(join(root, "tasks", "done"), { recursive: true });
    await writeFile(join(root, "tasks", "done", "TASK-099.md"), "# done");
    const { execute, calls } = ghStub({ body: "dependencies: [TASK-099]" });
    const result = await setIssueReady(root, 42, true, { execute });
    assert.equal(result.ok, true);
    assert.ok(calls.some(c => c.includes("--add-label agent:ready")), "label is applied");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setIssueReady on a closed issue is refused", async () => {
  const root = await temp();
  try {
    const { execute } = ghStub({ state: "CLOSED" });
    const result = await setIssueReady(root, 42, true, { execute });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "issue-closed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
