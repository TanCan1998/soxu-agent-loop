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

function ghStub({ state = "OPEN", body = "dependencies: [TASK-099]", labels = [], issues = [], prs = [] } = {}) {
  const calls = [];
  const execute = async (bin, args) => {
    calls.push(bin + " " + args.join(" "));
    if (args[0] === "issue" && args[1] === "view") {
      return { stdout: JSON.stringify({ number: 42, title: "[M2] [ISSUE-42] 示例", body, labels: labels.map(name => ({ name })), state }) };
    }
    if (args[0] === "issue" && args[1] === "list") return { stdout: JSON.stringify(issues) };
    if (args[0] === "pr" && args[1] === "list") return { stdout: JSON.stringify(prs) };
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

test("setIssueReady clears other state labels so only one remains", async () => {
  const root = await temp();
  try {
    await mkdir(join(root, "tasks", "done"), { recursive: true });
    const { execute, calls } = ghStub({ body: "", labels: ["agent:waiting", "agent:blocked", "bug"] });
    const result = await setIssueReady(root, 42, true, { execute });
    assert.equal(result.ok, true);
    const edit = calls.find(c => c.includes("issue edit"));
    assert.ok(edit.includes("--add-label agent:ready"), "adds ready");
    assert.ok(edit.includes("--remove-label agent:waiting"), "removes waiting");
    assert.ok(edit.includes("--remove-label agent:blocked"), "removes blocked");
    assert.ok(!edit.includes("--remove-label bug"), "non-state labels are untouched");
    assert.deepEqual(result.removed.sort(), ["agent:blocked", "agent:waiting"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setIssueReady does not re-add an existing ready label", async () => {
  const root = await temp();
  try {
    await mkdir(join(root, "tasks", "done"), { recursive: true });
    const { execute, calls } = ghStub({ body: "", labels: ["agent:ready", "agent:paused"] });
    await setIssueReady(root, 42, true, { execute });
    const edit = calls.find(c => c.includes("issue edit"));
    assert.ok(!edit.includes("--add-label"), "already ready, no add");
    assert.ok(edit.includes("--remove-label agent:paused"), "still clears the conflicting state");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doneTaskIds also accepts closed issues with a merged PR", async () => {
  const root = await temp();
  try {
    // tasks/done 为空：模拟「已合并但还没归档」的窗口期
    await mkdir(join(root, "tasks", "done"), { recursive: true });
    const { execute } = ghStub({
      body: "dependencies: [TASK-088]",
      issues: [{ number: 88, title: "[M1] [TASK-088] 已合并待归档", state: "CLOSED" }],
      prs: [{ body: "Closes #88" }],
    });
    const result = await setIssueReady(root, 42, true, { execute });
    assert.equal(result.ok, true, "closed + merged counts as done even before archiving");
    assert.deepEqual(result.missing, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doneTaskIds still refuses a closed issue with no merge record", async () => {
  const root = await temp();
  try {
    await mkdir(join(root, "tasks", "done"), { recursive: true });
    const { execute } = ghStub({
      body: "dependencies: [TASK-088]",
      issues: [{ number: 88, title: "[M1] [TASK-088] 手动关闭", state: "CLOSED" }],
      prs: [],
    });
    const result = await setIssueReady(root, 42, true, { execute });
    assert.equal(result.ok, false, "closed without a merge record is not done");
    assert.deepEqual(result.missing, ["TASK-088"]);
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
