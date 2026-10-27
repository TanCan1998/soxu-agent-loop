import { dataRoot } from "./config.mjs";
import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { evaluateLessons } from "./lessons.mjs";

// Read-only local metadata; report presence does not prove a lane is running.
async function reportState(root, lane) {
  const dir=join(dataRoot(root),"advisory",lane);
  try {
    const files=(await readdir(dir)).filter(x=>/^\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+\.json$/.test(x)).sort().slice(-1000);
    if (!files.length) return {status:"empty",count:0,lastAt:null};
    const info=await lstat(join(dir,files.at(-1)));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid report");
    return {status:"available",count:files.length,lastAt:info.mtime.toISOString()};
  } catch (error) {return error.code === "ENOENT" ? {status:"empty",count:0,lastAt:null} : {status:"unavailable",count:null,lastAt:null};}
}
export async function readLaneStatus(root) {
  const [product,quality,lessons]=await Promise.all([
    reportState(root,"product"),reportState(root,"quality"),
    (async()=>{try {
      const path=join(root,"LESSONS.md");const info=await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size>262144) throw new Error("invalid lessons file");
      const entries=evaluateLessons(await readFile(path,"utf8"));
      return {status:"available",count:entries.length,eligible:entries.filter(x=>x.eligible).length};
    } catch {return {status:"unavailable",count:null,eligible:null};}})(),
  ]);
  return {product,quality,lessons};
}
