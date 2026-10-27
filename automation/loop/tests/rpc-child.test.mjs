import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPi } from "../src/rpc.mjs";

test("RPC waits for agent_settled, not only accepted response", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "soxu-pi-mock-"));
  const script = join(dir, "fake-pi");
  const prev = process.env.SOXU_PI_BIN;
  try {
    await writeFile(script, `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => {
  const id = JSON.parse(c.trim()).id;
  process.stdout.write(JSON.stringify({ type:"response",id,command:"prompt",success:true,data:{disposition:"started"} })+"\\n");
  setTimeout(()=>{
    process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"OK"}})+"\\n");
    process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n");
  },35);
});
`);
    await chmod(script, 0o755);
    process.env.SOXU_PI_BIN = script;
    const began = Date.now();
    const result = await runPi({ cwd: dir, prompt: "Test", timeoutMs: 3000 });
    assert.equal(result.text, "OK");
    assert.ok(Date.now() - began >= 30);
  } finally { if (prev === undefined) delete process.env.SOXU_PI_BIN; else process.env.SOXU_PI_BIN = prev; await rm(dir,{recursive:true,force:true}); }
});
