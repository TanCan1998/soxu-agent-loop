import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionRecoveryCandidates } from "../src/blocked-recovery.mjs";

const task = (n, status, blockedRecoveryCount) => ({ issue: { number: n }, status, blockedRecoveryCount });

test("blocked tasks are retried automatically until the bounded limit", () => {
  const first = partitionRecoveryCandidates([task(1, "blocked", 0), task(2, "paused")], 2);
  assert.deepEqual(first.actionable.map(x => x.issue.number), [1, 2]);
  assert.deepEqual(first.exhausted, []);
  const third = partitionRecoveryCandidates([task(1, "blocked", 2)], 2);
  assert.deepEqual(third.actionable, []);
  assert.deepEqual(third.exhausted.map(x => x.issue.number), [1], "past the limit it must not preempt the queue");
});

test("paused tasks and missing counters never exhaust", () => {
  const result = partitionRecoveryCandidates([task(3, "paused", 9), task(4, "blocked")], 2);
  assert.deepEqual(result.actionable.map(x => x.issue.number), [3, 4]);
  assert.deepEqual(result.exhausted, []);
});

test("an invalid limit falls back to 2", () => {
  const result = partitionRecoveryCandidates([task(5, "blocked", 2)], "x");
  assert.equal(result.exhausted.length, 1);
});
