#!/usr/bin/env node
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const [projectArg, targetArg, flag, ...extra] = process.argv.slice(2);
if (!isAbsolute(projectArg || "") || !isAbsolute(targetArg || "") || flag !== "--offline" || extra.length)
  throw new Error("Usage: node migrate-data.mjs ABSOLUTE_PROJECT_PATH ABSOLUTE_NEW_DATA_PATH --offline (stop all old and new Dashboard/Runner processes first)");
const project = await realpath(projectArg), target = resolve(targetArg), source = join(project, ".soxu");
const overlap = (a,b) => {const r=relative(a,b);return !r || (r!==".." && !r.startsWith(".."+sep) && !isAbsolute(r));};
if (overlap(source,target) || overlap(target,source) || overlap(join(project,".git"),target)) throw new Error("Data target must be outside the old data directory and Git metadata");
try { await lstat(target); throw new Error("Target already exists; refusing to overwrite"); } catch(e) { if (e.code !== "ENOENT") throw e; }
const names = ["checkpoints", "advisory", "intake", "model-settings.json"];
try {
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Old data root must be a real directory");
  const unknown = (await readdir(source)).filter(name => ![...names, "locks"].includes(name));
  if (unknown.length) throw new Error(`Unrecognized data entries require inspection: ${unknown.join(", ")}`);
} catch (error) { if (error.code !== "ENOENT") throw error; }
async function snapshot(path) {
  let info;try {info=await lstat(path);} catch(e) {if(e.code==="ENOENT")return null;throw e;}
  if(info.isSymbolicLink()) throw new Error(`Symlink in data: ${path}`);
  if(info.isFile()) return createHash("sha256").update(await readFile(path)).digest("hex");
  if(!info.isDirectory()) throw new Error(`Unsupported data entry: ${path}`);
  const result={};for(const name of (await readdir(path)).sort()) result[name]=await snapshot(join(path,name));return result;
}
async function locksEmpty() {
  try {if((await readdir(join(source,"locks"))).length) throw new Error("Existing task locks must be investigated before migration");}
  catch(e) {if(e.code!=="ENOENT")throw e;}
}
await locksEmpty();
const before={};for(const name of names) before[name]=await snapshot(join(source,name));
await mkdir(dirname(target),{recursive:true});
const temp=await mkdtemp(join(dirname(target),".soxu-migration-"));
try {
  for(const name of names) if(before[name]!==null) await cp(join(source,name),join(temp,name),{recursive:true,errorOnExist:true,force:false});
  await locksEmpty();
  for(const name of names) {
    if(JSON.stringify(before[name])!==JSON.stringify(await snapshot(join(source,name))) || JSON.stringify(before[name])!==JSON.stringify(await snapshot(join(temp,name)))) throw new Error("Data changed during migration; no data activated");
  }
  await writeFile(join(temp,".soxu-project.json"),JSON.stringify({version:1,project},null,2)+"\n",{flag:"wx",mode:0o600});
  // Reserve the destination without replacing an existing directory; marker is activated last.
  await mkdir(target);
  for (const name of names) if (before[name] !== null) await rename(join(temp,name),join(target,name));
  await rename(join(temp,".soxu-project.json"),join(target,".soxu-project.json"));
  console.log(`Copied and verified data for ${project} to ${target}. Old data preserved. Set SOXU_PROJECT_ROOT and SOXU_DATA_DIR before starting the new runner; do not start the old runner.`);
} finally {await rm(temp,{recursive:true,force:true});}
