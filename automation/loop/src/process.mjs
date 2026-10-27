import { spawn } from "node:child_process";
import { classifyFailure, LoopFailure } from "./errors.mjs";

// On Windows only invoke trusted static .cmd commands through cmd.exe.
function normalize(bin, args) {
  if (process.platform !== "win32") return [bin, args];
  if (bin === "pi" && ["--help", "--list-models"].includes(args[0]) && args.length === 1) return ["cmd.exe", ["/d", "/s", "/c", `pi ${args[0]}`]];
  if (bin !== "pnpm") return [bin, args];
  const key = JSON.stringify(args);
  const commands = new Map([
    [JSON.stringify(["check"]), "pnpm check"],
    [JSON.stringify(["--version"]), "pnpm --version"],
    [JSON.stringify(["install", "--no-frozen-lockfile", "--ignore-scripts"]), "pnpm install --no-frozen-lockfile --ignore-scripts"]
  ]);
  if (!commands.has(key)) throw new Error("Windows pnpm command not allowlisted");
  return ["cmd.exe", ["/d", "/s", "/c", commands.get(key)]];
}

function killGroup(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const taskkill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    taskkill.on("error", () => {}); taskkill.unref();
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}

export function githubRepository(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  if (!match) throw new Error("GitHub operation requires a canonical github.com origin without credentials");
  return match[1];
}
export async function run(bin, args, { cwd, timeoutMs = 90_000, env = process.env, allowFailure = false, signal } = {}) {
  if (bin === "gh" && args[0] !== "--version") {
    if (!cwd) throw new Error("GitHub operation requires the target project directory");
    env = {...env};
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
    if (args.some(arg => arg === "--repo" || arg === "-R" || arg.startsWith("--repo="))) throw new Error("Explicit GitHub repository arguments are not permitted");
    const fetchUrl = (await run("git", ["remote", "get-url", "origin"], {cwd, env, timeoutMs:10000, signal})).stdout;
    const pushUrl = (await run("git", ["remote", "get-url", "--push", "origin"], {cwd, env, timeoutMs:10000, signal})).stdout;
    const repo = githubRepository(fetchUrl);
    if (githubRepository(pushUrl).toLowerCase() !== repo.toLowerCase()) throw new Error("GitHub origin and push origin do not match");
    if (env.GH_REPO && env.GH_REPO.replace(/^github\.com\//i, "").toLowerCase() !== repo.toLowerCase()) throw new Error("GH_REPO does not match target project origin");
    for (const arg of args) {
      const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/\d+/i.exec(arg);
      if (url && url[1].toLowerCase() !== repo.toLowerCase()) throw new Error("GitHub URL does not match target project origin");
    }
    env = {...env, GH_HOST:"github.com", GH_REPO:`github.com/${repo}`};
  }
  const [cmd, argv] = normalize(bin, args);
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", finished = false, timedOut = false, interrupted = false;
    const child = spawn(cmd, argv, { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let fallback;
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    // Do not release a task lock until the process has exited: otherwise a manual
    // resume could overlap a still-running compiler/Git operation from the last run.
    function stop() {
      killGroup(child);
      // A broken taskkill / inherited stdio must not hang the coordinator forever.
      fallback ??= setTimeout(() => complete(new LoopFailure(interrupted ? "interrupted" : "timeout", `${bin} termination did not complete`)), 3000);
    }
    const onAbort = () => { interrupted = true; stop(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const append = (s, chunk) => (s + chunk.toString("utf8")).slice(-1_000_000);
    child.stdout.on("data", c => { stdout = append(stdout, c); });
    child.stderr.on("data", c => { stderr = append(stderr, c); });
    child.on("error", e => complete(classifyFailure(e)));
    child.on("close", code => {
      if (interrupted) complete(new LoopFailure("interrupted", `${bin} was interrupted; subprocess tree terminated`));
      else if (timedOut) complete(new LoopFailure("timeout", `${bin} exceeded ${Math.round(timeoutMs/1000)}s; subprocess tree terminated`));
      else if (code !== 0 && !allowFailure) {
        const details = [stdout.slice(-4500), stderr.slice(-4500)].filter(Boolean).join("\n");
        const error = classifyFailure(new Error(`${bin} ${args.join(" ")} exit=${code}\n${details}`));
        error.exitCode = code;
        complete(error);
      }
      else complete(null, { code, stdout, stderr });
    });
    if (signal?.aborted) onAbort();
    function complete(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(fallback);
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve(value);
    }
  });
}

// Remote calls should fail quickly if the network is unavailable.
export async function git(args, cwd, opts = {}) { return (await run("git", args, { cwd, timeoutMs: args[0] === "fetch" || args[0] === "push" ? 45_000 : 60_000, ...opts })).stdout.trim(); }
export async function gh(args, cwd, opts = {}) { return (await run("gh", args, { cwd, timeoutMs: 45_000, ...opts })).stdout.trim(); }
