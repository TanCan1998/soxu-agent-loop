import { dataRoot } from "./config.mjs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ROOT } from "./config.mjs";
import { taskIdFromIssueTitle } from "./task-catalog.mjs";

const DIR = join(dataRoot(ROOT), "checkpoints");

function validNumber(id) {
  const number = Number(id);
  if (!Number.isSafeInteger(number) || number <= 0 || number >= 1e9) throw new Error("Invalid issue number");
  return number;
}
export function checkpointName(id, local = false) {
  return `${local ? "local" : "github"}-issue-${validNumber(id)}.json`;
}
function legacyName(id) { return `issue-${validNumber(id)}.json`; }
async function load(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (err) { if (err.code === "ENOENT") return null; throw err; }
}
/** Preserve a single checkpoint per (mode, issue number); never conflate local and GitHub IDs. */
export async function writeCheckpoint(state, directory = DIR) {
  const number = validNumber(state?.issue?.number);
  const local = state.local === true;
  await mkdir(directory, { recursive: true });
  const file = join(directory, checkpointName(number, local));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ schemaVersion: 2, ...state, local, updatedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(tmp, file);
    // Migrate only a legacy checkpoint belonging to this namespace.
    const oldPath = join(directory, legacyName(number));
    const old = await load(oldPath);
    if (old && Boolean(old.local) === local) await rm(oldPath, { force: true });
  } finally { await rm(tmp, { force: true }); }
}
export async function readCheckpoint(id, directory = DIR, local = false) {
  const current = await load(join(directory, checkpointName(id, local)));
  if (current) return current;
  const old = await load(join(directory, legacyName(id)));
  return old && Boolean(old.local) === local ? old : null;
}
export async function listPaused(directory = DIR, { includeBlocked = false } = {}) {
  let files;
  try { files = await readdir(directory); }
  catch (err) { if (err.code === "ENOENT") return []; throw err; }
  const cancelledDir=resolve(directory === DIR ? ROOT : resolve(directory,"..",".."),"tasks","cancelled");
  let markers;try {markers=await readdir(cancelledDir);} catch(e) {if(e.code!=="ENOENT")throw e;markers=[];}
  const cancelled=[];
  for(const name of markers.filter(x=>/^TASK-\d{3,}\.json$/.test(x))) {
    const marker=await load(join(cancelledDir,name));
    if(!marker || marker.taskId!==name.slice(0,-5) || !Number.isSafeInteger(marker.githubIssue) || marker.githubIssue<1) throw new Error(`Invalid cancelled task marker: ${name}`);
    cancelled.push(marker);
  }
  const found = new Map();
  // Prefer namespaced entries; old issue-N checkpoints are read-only migration fallbacks.
  for (const name of files.filter(x => /^(?:local-|github-)?issue-\d+\.json$/.test(x)).sort((a,b)=>Number(a.startsWith("issue-"))-Number(b.startsWith("issue-")))) {
    const state = await load(join(directory, name));
    if (!state || !["paused", "running", ...(includeBlocked ? ["blocked"] : [])].includes(state.status)) continue;
    const taskId=taskIdFromIssueTitle(state.issue?.title);
    if(cancelled.some(x=>x.taskId===taskId || (!state.local && x.githubIssue===state.issue?.number))) continue;
    const local = Boolean(state.local);
    if (name.startsWith("local-") && !local || name.startsWith("github-") && local) throw new Error(`Checkpoint namespace mismatch: ${name}`);
    const key = checkpointName(state.issue?.number, local);
    if (!found.has(key)) found.set(key, state);
  }
  return [...found.values()].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
}
export async function clearCheckpoint(id, directory = DIR, local = false) {
  await rm(join(directory, checkpointName(id, local)), { force: true });
  const oldPath = join(directory, legacyName(id));
  const old = await load(oldPath);
  if (old && Boolean(old.local) === local) await rm(oldPath, { force: true });
}
