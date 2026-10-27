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

export async function run(bin, args, { cwd, timeoutMs = 90_000, env = process.env, allowFailure = false, signal } = {}) {
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
