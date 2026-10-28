import { test } from "node:test";
import assert from "node:assert/strict";
import {hasRequiredChecks,REQUIRED_CHECKS} from "../src/branch-protection.mjs";
test("auto merge requires the aggregate gate and commit validation",()=>{
  const protection={required_pull_request_reviews:{},required_status_checks:{contexts:REQUIRED_CHECKS}};
  assert.equal(hasRequiredChecks(protection),true);
  // 没有 PR review 要求同样算受保护：评审在本地 reviewer 阶段完成，
  // --auto 会等必需检查通过才合并（单 token 无法自批 PR）。
  assert.equal(hasRequiredChecks({...protection,required_pull_request_reviews:null}),true);
  assert.equal(hasRequiredChecks({required_status_checks:{contexts:REQUIRED_CHECKS}}),true);
  assert.equal(hasRequiredChecks({...protection,required_status_checks:{contexts:["quality"]}}),false);
  assert.equal(hasRequiredChecks({...protection,required_status_checks:{checks:REQUIRED_CHECKS.map(context=>({context}))}}),true);
  assert.equal(hasRequiredChecks(null),false);
});
