import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReviewRejection, beginBlockedRetry } from "../src/worker.mjs";

test("a rejected review is persisted even when the review budget is exhausted", () => {
  const exhausted = { attempt: 1 };
  const result = applyReviewRejection(exhausted, "AC1 未接通；stop 阻塞数十秒", 1);
  assert.equal(result.exhausted, true);
  assert.equal(exhausted.lastReview, "AC1 未接通；stop 阻塞数十秒", "conclusion survives the block");
  assert.match(exhausted.feedback, /REVIEW FEEDBACK/);
  assert.match(exhausted.feedback, /AC1 未接通/);
});

test("a review with remaining budget advances the attempt counter", () => {
  const state = { attempt: 0 };
  assert.equal(applyReviewRejection(state, "补充测试", 2).exhausted, false);
  assert.equal(state.attempt, 1);
  assert.match(state.feedback, /补充测试/);
});

test("retrying a blocked task resets the review budget; paused tasks keep theirs", () => {
  const blocked = { attempt: 1 };
  assert.equal(beginBlockedRetry(blocked, "blocked"), true);
  assert.equal(blocked.attempt, 0, "a retry must be able to pass review");
  const paused = { attempt: 1 };
  assert.equal(beginBlockedRetry(paused, "paused"), false);
  assert.equal(paused.attempt, 1, "quota/network pauses keep the original budget");
});
