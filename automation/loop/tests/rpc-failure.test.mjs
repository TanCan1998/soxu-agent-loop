import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPi } from "../src/rpc.mjs";

// On Windows fake Pi must be a .cmd shim; process-mode test runs on POSIX only.
async function withFakePi(code, callback) {
  const dir = await mkdtemp(join(tmpdir(), "soxu-pi-failure-"));
  const file = join(dir, "fake-pi");
  const prev = process.env.SOXU_PI_BIN;
  try {
    await writeFile(file, `#!/usr/bin/env node\n${code}\n`);
    await chmod(file,0o755);
    process.env.SOXU_PI_BIN = file;
    await callback(dir);
  } finally {
    if (prev === undefined) delete process.env.SOXU_PI_BIN; else process.env.SOXU_PI_BIN = prev;
    await rm(dir,{recursive:true,force:true});
  }
}

test("quota error immediately suspends without RPC retry", {skip:process.platform === "win32"}, async () => {
  await withFakePi(`let buffer="";process.stdin.on("data",c=>{buffer+=c;for(const l of buffer.split("\\n").filter(Boolean)){const m=JSON.parse(l);if(m.type==="prompt"){process.stdout.write(JSON.stringify({type:"response",id:m.id,success:false,error:"HTTP 429 insufficient_quota"})+"\\n");break;}}});`, async dir => {
    const error = await runPi({ cwd:dir,prompt:"write code",timeoutMs:2000 }).then(()=>null,e=>e);
    assert.equal(error.kind,"quota");
  });
});

test("silent accepted Pi task hits short idle budget, not full hard budget", {skip:process.platform === "win32"}, async () => {
  await withFakePi(`let b="";process.stdin.on("data",c=>{b+=c;for(const line of b.split("\\n").filter(Boolean)){const m=JSON.parse(line);if(m.type==="prompt") process.stdout.write(JSON.stringify({type:"response",id:m.id,success:true,data:{disposition:"started"}})+"\\n");}});`, async dir => {
    const started = Date.now();
    const error = await runPi({ cwd:dir,prompt:"write code", timeoutMs:5000, timeouts:{piIdleSeconds:0.18, piStartupSeconds:1, shutdownGraceSeconds:0.1} }).then(()=>null,e=>e);
    assert.equal(error.kind,"timeout");
    assert.match(error.message,/inactive/);
    assert.ok(Date.now()-started < 1500);
  });
});

test("unresponsive Pi startup hits startup budget", {skip:process.platform === "win32"}, async () => {
  await withFakePi(`process.stdin.resume();`, async dir => {
    const error = await runPi({ cwd:dir,prompt:"write code", timeoutMs:5000, timeouts:{piStartupSeconds:0.18,piIdleSeconds:3,shutdownGraceSeconds:0.1} }).then(()=>null,e=>e);
    assert.equal(error.kind,"timeout");
    assert.match(error.message,/startup/);
  });
});
