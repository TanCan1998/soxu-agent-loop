import { test } from "node:test";
import assert from "node:assert/strict";
import {hasRequiredChecks,REQUIRED_CHECKS} from "../src/branch-protection.mjs";
test("auto merge requires PR protection and the aggregate gate and commit validation",()=>{
  const protection={required_pull_request_reviews:{},required_status_checks:{contexts:REQUIRED_CHECKS}};
  assert.equal(hasRequiredChecks(protection),true);
  assert.equal(hasRequiredChecks({...protection,required_pull_request_reviews:null}),false);
  assert.equal(hasRequiredChecks({...protection,required_status_checks:{contexts:["quality"]}}),false);
  assert.equal(hasRequiredChecks({...protection,required_status_checks:{checks:REQUIRED_CHECKS.map(context=>({context}))}}),true);
  assert.equal(hasRequiredChecks(null),false);
});
