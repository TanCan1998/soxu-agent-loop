/**
 * Offline, deterministic recovery command parser.
 * This intentionally never calls Pi or another model: it must still work when quota is exhausted.
 * Unknown/ambiguous instructions fail closed rather than execute shell text.
 */
const ACTION = /(?:继续|恢复|接着|续跑|续做|接续|重试|resume|continue|retry)/i;
const NEGATIVE = /(?:不(?:要|用|再)?\s*(?:恢复|继续|重试)|别\s*(?:恢复|继续|重试)|取消\s*(?:恢复|继续)|do\s*not\s*(?:resume|continue)|don't\s*(?:resume|continue)|stop\s*(?:resum|continu))/i;
const UNSAFE = /(?:删除|清空|重置|覆盖|强推|强制合并|跳过检查|绕过审核|rm\s+-rf|reset\s+--hard|force\s+push|drop\s+(?:database|table))/i;
const ALL = /(?:全部|所有|每个|全都|all|every)/i;
const REF = /(?:\bissue\s*#?\s*(\d{1,7})\b|任务\s*(?:#|编号|第)?\s*(\d{1,7})\s*(?:号)?|#(\d{1,7})\b)/ig;

export function parseRecoveryIntent(input) {
  if (typeof input !== "string" || input.length < 2 || input.length > 240) throw new Error("恢复指令长度应为 2–240 个字符");
  const text = input.normalize("NFKC").trim();
  if (!ACTION.test(text)) throw new Error("无法识别恢复意图。示例：继续 SOXU / 恢复上次中断的任务 / 恢复 Issue 123");
  if (NEGATIVE.test(text) || UNSAFE.test(text)) throw new Error("指令包含否定或危险操作，不执行恢复");
  const ids = [...text.matchAll(REF)].map(match => Number(match[1] || match[2] || match[3]));
  // Also support '恢复 123', without interpreting incidental numbers in other prose as Issue IDs.
  if (!ids.length && /^(?:恢复|重试|resume|retry)\s+#?\d{1,7}\s*[。.!！]?$/i.test(text)) {
    const number = Number(text.match(/\d+/)[0]);
    ids.push(number);
  }
  if (new Set(ids).size > 1) throw new Error("同时出现多个不同 Issue 编号，请一次恢复一个或明确使用“恢复所有暂停任务”");
  if (ids.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error("Issue 编号无效");
  if (ALL.test(text) && ids.length) throw new Error("不能同时指定 Issue 编号和“全部”范围");
  if (ids.length) return { scope: "issue", issueNumber: ids[0] };
  if (ALL.test(text)) return { scope: "all" };
  if (/(?:SOXU|上次|最近|刚才|最后|最新|中断|暂停|任务|开发|工作|进度|断点|未完成|上一步|之前|last|previous|paused|interrupted|work)/i.test(text)) return { scope: "latest" };
  throw new Error("恢复范围不明确。请使用“继续 SOXU”“恢复上次中断的任务”或“恢复 Issue 123”");
}

/** Candidates are only paused tasks: a running checkpoint might belong to another live agent. */
export function selectRecoveryCandidates(states, intent, { localOnly = false, githubOnly = false } = {}) {
  if (localOnly && githubOnly) throw new Error("Local and GitHub scope cannot both be selected");
  const list = states.filter(s => s?.status === "paused" && (!localOnly || s.local === true) && (!githubOnly || !s.local));
  if (intent.scope === "issue") {
    const matches = list.filter(s => Number(s.issue?.number) === intent.issueNumber);
    if (!matches.length) throw new Error(`Issue #${intent.issueNumber} 不存在可恢复的暂停检查点；运行中或已阻塞任务不会自动接管`);
    if (matches.length > 1) throw new Error(`Issue #${intent.issueNumber} 同时存在本地/GitHub 检查点，请指定 --local 或 --github`);
    return matches;
  }
  const sorted = [...list].sort((a, b) => (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0));
  return intent.scope === "latest" ? sorted.slice(0, 1) : sorted;
}
