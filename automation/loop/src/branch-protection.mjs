// Require the stable aggregate CI gate and commit validation.
export const REQUIRED_CHECKS = Object.freeze(["SOXU CI Gate", "Validate commit messages"]);
export function hasRequiredChecks(protection) {
  const checks = protection?.required_status_checks;
  if (!checks || !protection.required_pull_request_reviews) return false;
  const contexts = new Set([...(Array.isArray(checks.contexts) ? checks.contexts : []), ...(Array.isArray(checks.checks) ? checks.checks.map(x => x?.context) : [])]);
  return REQUIRED_CHECKS.every(name => contexts.has(name));
}
