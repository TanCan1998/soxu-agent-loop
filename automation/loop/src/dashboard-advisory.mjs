import { dataRoot } from "./config.mjs";
import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseAdvisory, runAdvisory } from "./advisory.mjs";
import { classifyFailure } from "./errors.mjs";

const VALID = new Set(["product", "quality"]);
function invalid(message,status=400) {return Object.assign(new Error(message),{status});}
const REPORT_NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+\.json$/;
function reportDir(root, lane) {
  if (!VALID.has(lane)) throw invalid("invalid-lane");
  return join(dataRoot(root), "advisory", lane);
}
async function checkedDir(root, lane) {
  const dir=reportDir(root,lane);
  for (const path of [dataRoot(root),join(dataRoot(root),"advisory"),dir]) {
    const info=await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid("report-unavailable",503);
  }
  return dir;
}
export async function listReports(root, lane, limit=1000) {
  let dir, names;
  try {dir=await checkedDir(root,lane);names=(await readdir(dir)).filter(x=>REPORT_NAME.test(x)).sort().reverse();}
  catch(error) {if(error.code === "ENOENT") return []; throw error;}
  const reports=[];
  for (const name of names.slice(0,limit)) {
    try {const info=await lstat(join(dir,name));if(info.isFile() && !info.isSymbolicLink() && info.size<=128000) reports.push({name,modifiedAt:info.mtime.toISOString()});}
    catch(error) {if(error.code!=="ENOENT") throw error;}
  }
  return reports;
}
export async function readReport(root, lane, name) {
  if (typeof name!=="string" || !REPORT_NAME.test(name)) throw invalid("invalid-report");
  const dir=await checkedDir(root,lane), path=join(dir,name), info=await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size>128000) throw invalid("report-unavailable",503);
  let input; try {input=JSON.parse(await readFile(path,"utf8"));} catch {throw invalid("report-unavailable",503);}
  let result; try {result=parseAdvisory("SOXU_ADVISORY_RESULT:"+JSON.stringify(input),lane);} catch {throw invalid("report-unavailable",503);}
  return {...result,createdAt:typeof input.createdAt==="string" && Number.isFinite(Date.parse(input.createdAt)) ? input.createdAt : null, origin:"model-proposal-unverified"};
}
export async function readLatestReport(root, lane) {
  const reports=await listReports(root,lane);
  return reports.length ? readReport(root,lane,reports[0].name) : null;
}
export async function deleteReports(root, lane, name) {
  if (name !== null && (typeof name!=="string" || !REPORT_NAME.test(name))) throw invalid("invalid-report");
  const reports=await listReports(root,lane,Infinity), targets=name === null ? reports : reports.filter(r=>r.name===name);
  if (name !== null && !targets.length) throw invalid("report-not-found",404);
  const dir=targets.length ? await checkedDir(root,lane) : null;
  let deleted=0;
  for (const target of targets) {
    const path=join(dir,target.name);
    try {const info=await lstat(path);if(!info.isFile() || info.isSymbolicLink()) throw invalid("report-unavailable",503);await unlink(path);deleted++;}
    catch(error) {if(error.code!=="ENOENT") throw error;}
  }
  return {deleted};
}
export class AdvisoryManager {
  constructor({root,run=runAdvisory,onChange=()=>{}}) {this.root=root;this.run=run;this.onChange=onChange;this.active=null;this.last=null;this.counters={product:0,quality:0};}
  state() {return {active:this.active ? {lane:this.active.lane,startedAt:this.active.startedAt,model:this.active.model ?? null} : null,last:this.last};}
  start(lane) {
    if (!VALID.has(lane)) throw invalid("invalid-lane");
    if (this.active) throw invalid("advisory-busy",409);
    const job={lane,startedAt:new Date().toISOString(),controller:new AbortController()};
    this.active=job;this.onChange();
    Promise.resolve().then(()=>this.run(lane,{root:this.root,signal:job.controller.signal,modelIndex:this.counters[lane]++,onModel:model=>{job.model=model;this.onChange();}})).then(()=>{
      this.last={lane,status:"completed",finishedAt:new Date().toISOString(),reason:null};
    }).catch(error=>{
      const kind=classifyFailure(error).kind;
      this.last={lane,status:"failed",finishedAt:new Date().toISOString(),reason:["quota","network","timeout","interrupted"].includes(kind)?kind:"failure"};
    }).finally(()=>{if(this.active===job)this.active=null;this.onChange();});
    return this.state();
  }
  shutdown() {this.active?.controller.abort();}
}
