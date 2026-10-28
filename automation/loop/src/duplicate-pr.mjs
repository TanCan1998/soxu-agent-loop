// PR data is untrusted. Only explicit closing references and known task branches
// are treated as evidence; semantic similarity needs human review.
export function duplicatePrs(issueNumber, prs, base = "main") {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || !Array.isArray(prs)) throw new Error("Invalid duplicate PR input");
  const close = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#${issueNumber}\b`, "i");
  const branch = new RegExp(`^agent/(?:github-issue-|issue-)${issueNumber}-`);
  return prs.filter(p => p?.state === "OPEN" && p.baseRefName === base &&
    (close.test(String(p.body ?? "")) || branch.test(String(p.headRefName ?? ""))))
    .map(p => ({number:p.number, url:p.url})).filter(p => Number.isSafeInteger(p.number) && p.number > 0);
}

const COMMON = new Set(["优化", "记录", "处理", "任务", "实现", "问题", "支持", "更新", "流程", "github", "agent", "检查"]);
function terms(value) {
  const result = new Set();
  for (const match of String(value ?? "").toLowerCase().slice(0, 300).matchAll(/[a-z][a-z0-9-]{2,}|[\u4e00-\u9fff]{2,}/g)) {
    const term = match[0];
    if (/^[a-z]/.test(term)) { if (!COMMON.has(term)) result.add(term); }
    else for (let i = 0; i < term.length - 1; i++) {
      const part = term.slice(i, i + 2); if (!COMMON.has(part)) result.add(part);
    }
  }
  return result;
}
// High-confidence lexical signal only; candidates are not declared duplicates.
export function similarPrs(issueTitle, prs, base = "main") {
  if (!Array.isArray(prs)) throw new Error("Invalid PR results");
  const issueTerms = terms(issueTitle);
  return prs.filter(p => p?.state === "OPEN" && p.baseRefName === base && Number.isSafeInteger(p.number) && p.number > 0)
    .map(p => {
      const matched = [...terms(p.title)].filter(t => issueTerms.has(t));
      return { number:p.number, title:String(p.title ?? "").slice(0, 120), matched };
    }).filter(p => p.matched.length >= 2).slice(0, 5);
}
