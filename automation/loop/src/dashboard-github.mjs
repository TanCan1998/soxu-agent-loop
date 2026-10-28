import { run } from "./process.mjs";
import { loadTaskCatalog, taskIdFromIssueTitle } from "./task-catalog.mjs";
import { mergedIssueNumbers } from "./github-queue.mjs";

// Remote data is advisory; scheduling remains governed by github-queue.mjs.
function safePrUrl(value, number) {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "github.com" && new RegExp(`^/[^/]+/[^/]+/pull/${number}$`).test(url.pathname) && !url.search && !url.hash ? url.href : null; } catch { return null; }
}
function safeIssueUrl(value, number) {
  try { const url=new URL(value); return url.protocol === "https:" && url.hostname === "github.com" && new RegExp(`^/[^/]+/[^/]+/issues/${number}$`).test(url.pathname) && !url.search && !url.hash ? url.href : null; } catch {return null;}
}
export function buildGithubStatus(catalog, issues, prs, base = "main") {
  const byTask = new Map();
  for (const issue of issues) {
    const id = taskIdFromIssueTitle(issue.title);
    if (!id) continue;
    if (byTask.has(id)) throw new Error("Duplicate task issue");
    byTask.set(id, issue);
  }
  const merged = mergedIssueNumbers(prs, base);
  const completed = new Set(catalog.filter(t => {
    const issue = byTask.get(t.id);
    return issue?.state === "CLOSED" && merged.has(issue.number);
  }).map(t => t.id));
  const tasks = {};
  for (const task of catalog) {
    const issue = byTask.get(task.id);
    const matches = issue ? prs.filter(pr => pr.baseRefName === "main" &&
      new RegExp(`(?:^|\\n)\\s*(?:closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve)\\s+#${issue?.number}\\b`, "im").test(String(pr.body ?? ""))) : [];
    const pr = matches.find(p => p.state === "OPEN") ?? matches.find(p => p.mergedAt) ?? null;
    let ci = "unknown";
    if (pr && Array.isArray(pr.statusCheckRollup) && pr.statusCheckRollup.length) {
      const checks = pr.statusCheckRollup;
      ci = checks.some(c => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STALE"].includes(c.conclusion) || c.state === "FAILURE" || c.state === "ERROR") ? "failure" :
        checks.some(c => c.status && c.status !== "COMPLETED" || c.state === "PENDING" || c.state === "EXPECTED") ? "pending" :
        checks.every(c => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion) || c.state === "SUCCESS") ? "success" : "unknown";
    }
    // Check runs are job-level summaries, not step logs.
    const activeChecks = pr && ci === "pending" ? (pr.statusCheckRollup ?? [])
      .filter(c => c.status && c.status !== "COMPLETED" && typeof c.name === "string")
      .slice(0, 10).map(c => ({
        name: c.name.slice(0, 120),
        jobId: (() => { try {
          const url = new URL(c.detailsUrl);
          const m = url.hostname === "github.com" && url.protocol === "https:" && /^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/(\d+)$/.exec(url.pathname);
          const id = m && Number(m[1]); return Number.isSafeInteger(id) && id > 0 ? id : null;
        } catch { return null; } })(),
        startedAt: typeof c.startedAt === "string" && Number.isFinite(Date.parse(c.startedAt)) ? c.startedAt : null,
      })) : [];
    tasks[task.id] = { issue: issue?.number ?? null, issueState: issue?.state ?? null,
      missing: task.dependencies.filter(id => !completed.has(id)),
      pr: pr ? {number: pr.number, title: String(pr.title ?? "").slice(0,200), url: safePrUrl(pr.url, pr.number), state: pr.mergedAt ? "merged" : pr.state === "OPEN" ? "open" : "closed", ci, ...(activeChecks.length ? {activeChecks} : {})} : null };
  }
  // Progress is derived from all explicitly classified Issues, never from a fixed task count.
  const stages=Object.fromEntries(["M0","M1","M2","M3","M4"].map(id=>[id,{id,total:0,merged:0,running:0,paused:0,unknown:0,issues:[],items:[]}]));
  const catalogById=new Map(catalog.map(t=>[t.id,t]));
  let unclassified=0;
  for (const issue of issues) {
    const id=taskIdFromIssueTitle(issue.title);
    const milestoneTitle=typeof issue.milestone?.title === "string" ? issue.milestone.title : "";
    const fromGithub=/^(M[0-4])(?:\b|\s|\s*[-:])/i.exec(milestoneTitle)?.[1]?.toUpperCase();
    const fromTitle=/^\[(M[0-4])\](?:\s|$)/.exec(String(issue.title ?? ""))?.[1];
    const stage=fromGithub ?? fromTitle ?? catalogById.get(id)?.milestone;
    // Include classified Issues and unresolved task/Agent items; other Issues are not assumed to be project work.
    const labels=new Set((issue.labels ?? []).map(l=>l.name));
    if (!stage || !stages[stage]) {if(id || [...labels].some(n=>n.startsWith("agent:"))) unclassified++;continue;}
    const target=stages[stage];target.total++;target.issues.push(issue.number);
    target.items.push({number:issue.number,title:String(issue.title ?? "").slice(0,160),state:issue.state,url:safeIssueUrl(issue.url,issue.number),labels:[...labels].filter(n=>["agent:blocked","agent:paused","agent:in-progress"].includes(n)),merged:issue.state === "CLOSED" && merged.has(issue.number)});
    if(issue.state === "CLOSED") {if(merged.has(issue.number))target.merged++;else target.unknown++;}
    else if(labels.has("agent:paused") || labels.has("agent:blocked"))target.paused++;
    else if(labels.has("agent:in-progress"))target.running++;
  }
  tasks.__roadmap={stages:Object.values(stages),unclassified,limited:issues.length>=1000 || prs.length>=1000};
  tasks.__queue = issues.map(i => ({number:i.number,title:String(i.title ?? "").slice(0,160), state:i.state, merged:merged.has(i.number),
      labels:(i.labels ?? []).map(l=>l.name).filter(n=>["agent:ready","agent:blocked","agent:waiting","agent:in-progress","agent:paused","agent:pr"].includes(n)),
      url: safeIssueUrl(i.url,i.number)}));
  return tasks;
}
function validTime(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null; }
export async function readGithubStatus(root, execute = run, base = "main") {
  const [catalog, issues, prs] = await Promise.all([
    loadTaskCatalog(root),
    execute("gh", ["issue", "list", "--state", "all", "--limit", "1000", "--json", "number,title,state,labels,url,milestone"], {cwd:root, timeoutMs:15000}),
    execute("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,title,url,state,body,baseRefName,mergedAt,statusCheckRollup"], {cwd:root, timeoutMs:15000}),
  ]);
  const snapshot = buildGithubStatus(catalog, JSON.parse(issues.stdout), JSON.parse(prs.stdout), base);
  await enrichActiveChecks(snapshot, root, execute);
  return snapshot;
}

export async function enrichActiveChecks(snapshot, root, execute = run) {
  // Bound read-only requests; an inaccessible job does not erase the whole snapshot.
  const checks = Object.values(snapshot).flatMap(task => task?.pr?.activeChecks ?? []).filter(c => c.jobId).slice(0, 5);
  await Promise.all(checks.map(async check => {
    try {
      const response = await execute("gh", ["api", `repos/{owner}/{repo}/actions/jobs/${check.jobId}`], {cwd:root, timeoutMs:10000});
      const job = JSON.parse(response.stdout);
      if (job.id !== check.jobId || !Array.isArray(job.steps)) throw new Error("Invalid job response");
      const step = job.steps.find(s => s.status === "in_progress") ?? null;
      check.step = step ? {name:String(step.name ?? "").slice(0,120), startedAt:validTime(step.started_at)} : null;
      const times = job.steps.flatMap(s => [validTime(s.started_at), validTime(s.completed_at)]).filter(Boolean).sort();
      check.stepObservedAt = times.at(-1) ?? null;
      check.stepStatus = "available";
    } catch {
      check.stepStatus = "unavailable";
    }
  }));
  return snapshot;
}
