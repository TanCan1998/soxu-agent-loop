/** Categorize infrastructure failures without retrying paid model requests blindly. */
export class LoopFailure extends Error {
  constructor(kind, message, cause) {
    super(message, { cause });
    this.name = "LoopFailure";
    this.kind = kind;
  }
}
const QUOTA = /(?:insufficient[_ -]?(?:quota|credits|balance)|(?:quota|credits|balance)\s+(?:exhausted|exceeded|depleted)|billing[_ -]?(?:hard[_ -]?limit|limit|error)|(?:rate[_ -]?limit|too many requests)|(?:HTTP\s*)?429\b|resource_exhausted|usage[_ -]?limit|out of credits|credit limit reached)/i;
const NETWORK = /(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENOTFOUND|EHOSTUNREACH|fetch failed|network(?: is)? unreachable|connection (?:error|reset|refused|closed|timed out)|socket hang up|TLS handshake|temporary failure in name resolution|gateway timeout|(?:HTTP\s*)?50[234]\b|(?:HTTP\s*)?408\b)/i;
const AUTH = /(?:invalid[_ -]?api[_ -]?key|authentication failed|unauthorized|invalid credentials|(?:HTTP\s*)?401\b|(?:HTTP\s*)?403\b)/i;
export function classifyFailure(err) {
  if (err?.kind) return err;
  const value = String(err?.message ?? err ?? "unknown failure");
  const kind = QUOTA.test(value) ? "quota" : NETWORK.test(value) ? "network" : AUTH.test(value) ? "auth" : "failure";
  return new LoopFailure(kind, value, err);
}
export function isRecoverable(failure) {
  return ["quota", "network", "timeout", "interrupted"].includes(classifyFailure(failure).kind);
}
/** Issue comments and local files must not leak credentials or full API responses. */
export function safeFailureMessage(err, limit = 700) {
  const message = classifyFailure(err).message;
  return message.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gi, "[redacted]").replace(/(?:ghp_[a-z\d]{15,}|github_pat_[a-z\d_]{15,}|sk-[a-z\d_-]{15,}|Bearer\s+\S+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/gi, "[redacted]").slice(0, Math.min(Math.max(limit, 0), 10000));
}
