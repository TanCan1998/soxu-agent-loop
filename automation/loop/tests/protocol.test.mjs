import { test } from "node:test";
import assert from "node:assert/strict";
import { LineFramer, parseReview } from "../src/rpc.mjs";
import { isProtected, slug } from "../src/guards.mjs";

test("Pi JSONL parser handles split chunks and Unicode line separators", () => {
  const messages = [];
  const framer = new LineFramer(x => messages.push(x));
  framer.push('{"type":"text","text":"A\u2028B"}\n{"type":"agent_');
  framer.push('settled"}\r\n');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, "A\u2028B");
  assert.equal(messages[1].type, "agent_settled");
});
test("reviewer response must be explicit valid boolean", () => {
  assert.deepEqual(parseReview('ok\nSOXU_REVIEW_RESULT:{"approved":true,"summary":"safe"}'), {approved:true,summary:"safe"});
  assert.throws(() => parseReview("approved"));
  assert.throws(() => parseReview('SOXU_REVIEW_RESULT:{"approved":"yes","summary":"x"}'));
});
test("governance paths protected and task slugs sanitized", () => {
  const paths = [".github/workflows/", "AGENTS.md", "agents/policies/"];
  assert.equal(isProtected("AGENTS.md", paths), true);
  assert.equal(isProtected(".github/workflows/ci.yml", paths), true);
  assert.equal(isProtected("src/main.rs", paths), false);
  assert.equal(slug("AI: Fix / config!"), "ai-fix-config");
});
