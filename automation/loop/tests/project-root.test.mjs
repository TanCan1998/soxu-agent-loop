import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = fileURLToPath(new URL("../src/config.mjs", import.meta.url));
const toolRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("package scripts expose the documented agent:* entry points", async () => {
  const pkg = JSON.parse(await readFile(join(toolRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["agent:dashboard"], "node automation/loop/src/dashboard-cli.mjs");
  for (const command of ["start", "loop", "watch", "status", "doctor", "models", "update", "cleanup", "seed-issues"]) {
    assert.equal(pkg.scripts["agent:" + command], "node automation/loop/src/cli.mjs " + command, command);
  }
  assert.equal(pkg.scripts.agent, "node automation/loop/src/cli.mjs");
});
const probe = (value) => spawnSync(process.execPath, ["--input-type=module", "-e", `import {ROOT, TOOL_ROOT} from ${JSON.stringify(new URL("../src/config.mjs", import.meta.url).href)}; console.log(JSON.stringify({ROOT, TOOL_ROOT}))`], {
  env: { ...process.env, SOXU_PROJECT_ROOT: value }, encoding: "utf8",
});

test("project root prefers the env var and falls back to a sibling checkout", async () => {
  const { pickProjectRoot } = await import(pathToFileURL(config).href);
  const toolRoot = resolve("soxu-agent-loop");
  const explicit = resolve("soxu-project");
  assert.deepEqual(pickProjectRoot({ value: explicit, toolRoot, exists: () => true }), { root: explicit, source: "env" });
  // A relative or empty override must never silently fall back.
  for (const value of ["relative-project", ""]) {
    assert.throws(() => pickProjectRoot({ value, toolRoot, exists: () => true }), /must be a non-empty absolute path/);
  }
  const sibling = pickProjectRoot({ value: undefined, toolRoot, exists: path => path.endsWith(".git") });
  assert.equal(sibling.source, "sibling");
  assert.equal(sibling.root, resolve(toolRoot, "..", "SOXU"));
  assert.throws(() => pickProjectRoot({ value: undefined, toolRoot, exists: () => false }), /SOXU_PROJECT_ROOT is required/);
});

test("explicit project root is independent from tool installation", () => {
  const target = resolve(config, "../../../../separate-project");
  const result = probe(target);
  assert.equal(result.status, 0, result.stderr);
  const paths = JSON.parse(result.stdout);
  assert.equal(paths.ROOT, target);
  assert.notEqual(paths.ROOT, paths.TOOL_ROOT);
});

test("relative and empty explicit project roots fail closed", () => {
  for (const target of ["relative-project", ""]) {
    const result = probe(target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SOXU_PROJECT_ROOT must be a non-empty absolute path/);
  }
});

test("relocated CLI reads the target's legacy checkpoint without writing it", async () => {
  const base = await mkdtemp(join(tmpdir(), "soxu-split-"));
  const tool = join(base, "tool"), project = join(base, "project");
  try {
    await cp(new URL("../src", import.meta.url), join(tool, "automation/loop/src"), {recursive:true});
    await mkdir(join(project, "automation"), {recursive:true});
    await cp(join(process.env.SOXU_PROJECT_ROOT, "automation/policy.json"), join(project, "automation/policy.json"));
    await mkdir(join(project, "tasks/backlog"), {recursive:true});
    await writeFile(join(project, "tasks/backlog/TASK-001.md"), "# Target task\n");
    await mkdir(join(project, ".soxu/checkpoints"), {recursive:true});
    const checkpoint = JSON.stringify({issue:{number:1,title:"[TASK-001] Target task"}, local:true, status:"paused", phase:"checks"});
    await writeFile(join(project, ".soxu/checkpoints/issue-1.json"), checkpoint);
    const script = join(tool, "automation/loop/src/cli.mjs");
    const env = {...process.env, SOXU_PROJECT_ROOT: project};
    const result = spawnSync(process.execPath, [script, "status", "--local", "--json"], {cwd:tool, env, encoding:"utf8"});
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.paused[0].title, "Target task");
    assert.equal(state.paused[0].phase, "checks");
    const {readFile} = await import("node:fs/promises");
    assert.equal(await readFile(join(project, ".soxu/checkpoints/issue-1.json"), "utf8"), checkpoint);
  } finally { await rm(base, {recursive:true, force:true}); }
});
