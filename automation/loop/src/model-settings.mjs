import { dataRoot } from "./config.mjs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT } from "./config.mjs";
import { run } from "./process.mjs";
import { isModelIdentifier } from "./model-identifiers.mjs";

export const MODEL_ROLES=["developer","reviewer","product","quality","intake"];
const MAX_POOL=20;
const empty=()=>({schemaVersion:1,revision:0,global:[],roles:Object.fromEntries(MODEL_ROLES.map(r=>[r,null])),favorites:[]});
function validItem(x) {return x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).sort().join(",")==="model,provider" && typeof x.provider === "string" && typeof x.model === "string" && isModelIdentifier(x.provider) && isModelIdentifier(x.model);}
function validList(x, max) {return Array.isArray(x) && x.length<=max && x.every(validItem) && new Set(x.map(v=>`${v.provider}\0${v.model}`)).size===x.length;}
export function validateSettings(s) {
  if(!s || s.schemaVersion!==1 || !Number.isSafeInteger(s.revision) || s.revision<0 || Object.keys(s).sort().join(",")!=="favorites,global,revision,roles,schemaVersion" || !s.roles || Object.keys(s.roles).sort().join(",")!==[...MODEL_ROLES].sort().join(",") || !validList(s.global,MAX_POOL) || !validList(s.favorites,500) || MODEL_ROLES.some(r=>s.roles[r]!==null && (!validList(s.roles[r],MAX_POOL) || !s.roles[r].length))) throw new Error("invalid-model-settings");
  return s;
}
export async function readModelSettings(root=ROOT) {
  const path=join(dataRoot(root),"model-settings.json");
  try {const info=await lstat(path);if (!info.isFile() || info.isSymbolicLink() || info.size>200000) throw new Error("invalid-model-settings");return validateSettings(JSON.parse(await readFile(path,"utf8")));} catch(e){if(e.code==="ENOENT")return empty();throw e;}
}
let saving=false;
export async function saveModelSettings(input,root=ROOT) {
  if(saving) throw Object.assign(new Error("model-settings-busy"),{status:409});
  saving=true;
  try {
    validateSettings(input);
    const current=await readModelSettings(root);
    if(input.revision!==current.revision) throw Object.assign(new Error("model-settings-changed"),{status:409});
    const next={...input,revision:current.revision+1};
    const dir=dataRoot(root), path=join(dir,"model-settings.json"), tmp=join(dir,`model-settings-${randomUUID()}.tmp`);
    await mkdir(dir,{recursive:true});
    try {await writeFile(tmp,JSON.stringify(next,null,2)+"\n",{flag:"wx",mode:0o600});await rename(tmp,path);} finally {await rm(tmp,{force:true});}
    return next;
  } finally {saving=false;}
}
export function selectModel(settings,role,index,baseline) {
  if(!MODEL_ROLES.includes(role) || !Number.isSafeInteger(index) || index<0) throw new Error("invalid-model-selection");
  const pool=settings.roles[role] ?? (settings.global.length ? settings.global : null);
  const item=pool?.[index%pool.length];
  return item ? {...item,thinking:null} : baseline;
}
export function parsePiModelList(text) {
  const lines=String(text).replace(/\x1b\[[0-9;]*m/g,"").split(/\r?\n/);
  const header=lines.findIndex(line=>/^\s*provider\s+model\s+context\s+max-out\s+thinking\s+images\s*$/i.test(line));
  if(header<0) throw new Error("unrecognized-model-list");
  const result=[], seen=new Set();
  for(const line of lines.slice(header+1)) {
    if(!line.trim())continue;
    const cells=line.trim().split(/\s+/);
    if(cells.length!==6 || !isModelIdentifier(cells[0]) || !isModelIdentifier(cells[1]) || !/^(yes|no)$/i.test(cells[4]) || !/^(yes|no)$/i.test(cells[5])) throw new Error("unrecognized-model-list");
    const key=cells[0]+"\0"+cells[1];if(seen.has(key))continue;
    seen.add(key);result.push({provider:cells[0],model:cells[1]});
    if(result.length>5000)throw new Error("model-list-too-large");
  }
  return result;
}
export async function getPiModels(root=ROOT,execute=run) {
  const result=await execute("pi",["--list-models"],{cwd:root,timeoutMs:30000});
  let models;
  try {models=parsePiModelList(result.stdout);} catch {models=parsePiModelList(result.stderr);}
  return {models,warning:Boolean(result.stderr?.trim()) && !/^\s*provider\s+model\s+context/im.test(result.stderr)};
}
