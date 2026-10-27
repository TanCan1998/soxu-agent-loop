/** Evidence-led lessons. This module NEVER edits protected policy files. */
const OBSERVATION = /<!--\s*soxu-lesson\s+(\{[^\r\n]*\})\s*-->/g;
const ID = /^[a-z][a-z0-9-]{2,63}$/;
const EVIDENCE = /(?:#\d+|\b[0-9a-f]{7,40}\b|https:\/\/[^\s]+)/i;

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(`${value}T`);
}

/** Only count independently dated, reference-backed observations; one day counts once. */
export function evaluateLessons(markdown, threshold = 3) {
  if (!Number.isSafeInteger(threshold) || threshold < 2) throw new Error('Invalid lesson threshold');
  const lessons = new Map();
  let match;
  for (const m of markdown.matchAll(OBSERVATION)) {
    match = m;
    let row;
    try { row = JSON.parse(match[1]); }
    catch { throw new Error(`Invalid lesson JSON at character ${match.index}`); }
    if (!row || !ID.test(row.id ?? '') || !validDate(row.date) ||
        typeof row.rule !== 'string' || row.rule.trim().length < 10 || row.rule.length > 500 ||
        typeof row.evidence !== 'string' || !EVIDENCE.test(row.evidence) || row.evidence.length > 500)
      throw new Error(`Invalid lesson observation at character ${match.index}`);
    const current = lessons.get(row.id) ?? { id: row.id, rule: row.rule.trim(), observations: new Map() };
    if (current.rule !== row.rule.trim()) throw new Error(`Conflicting rule for ${row.id}`);
    const existing = current.observations.get(row.date) ?? [];
    if (!existing.includes(row.evidence)) existing.push(row.evidence);
    current.observations.set(row.date, existing);
    lessons.set(row.id, current);
  }
  return [...lessons.values()].map(({ id, rule, observations }) => ({
    id, rule, days: observations.size, eligible: observations.size >= threshold,
    observations: [...observations.entries()].sort(([a],[b])=>a.localeCompare(b))
      .map(([date, evidence])=>({date,evidence}))
  })).sort((a,b)=>a.id.localeCompare(b.id));
}

export function promotionCandidates(markdown, threshold = 3) {
  return evaluateLessons(markdown, threshold).filter(row=>row.eligible);
}
