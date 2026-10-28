// Require the stable aggregate CI gate and commit validation.
export const REQUIRED_CHECKS = Object.freeze(["SOXU CI Gate", "Validate commit messages"]);
export function hasRequiredChecks(protection) {
  const checks = protection?.required_status_checks;
  // 不要求 required_pull_request_reviews：
  // 评审由本地 reviewer 阶段完成；GitHub 侧若开 review 要求，单 token 的 agent PR
  // 永远等不到批准（不能自批），--auto 会一直挂着。安全性由"必需检查"保证——
  // gh pr merge --auto 只在必需检查全绿后才真正合并。
  if (!checks) return false;
  const contexts = new Set([...(Array.isArray(checks.contexts) ? checks.contexts : []), ...(Array.isArray(checks.checks) ? checks.checks.map(x => x?.context) : [])]);
  return REQUIRED_CHECKS.every(name => contexts.has(name));
}
