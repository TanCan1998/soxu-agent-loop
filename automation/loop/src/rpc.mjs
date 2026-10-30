import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { LoopFailure, classifyFailure } from "./errors.mjs";
import { modelArgs } from "./agent-models.mjs";
import { extractCommand, idleBudgetFor, IDLE_EXTENSION_DEFAULT_SECONDS, SLOW_COMMAND_DEFAULTS } from "./idle-extension.mjs";

export class LineFramer {
  constructor(onRecord, maxLineSize = 32 * 1024 * 1024) { this.buffer = ""; this.onRecord = onRecord; this.maxLineSize = maxLineSize; }
  push(text) {
    this.buffer += text;
    if (this.buffer.length > this.maxLineSize && !this.buffer.includes("\n")) throw new Error("RPC line exceeds limit");
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > this.maxLineSize) throw new Error("RPC line exceeds limit");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) this.onRecord(JSON.parse(line));
    }
  }
}

export function parseReview(text) {
  const match = /(?:^|\n)SOXU_REVIEW_RESULT:\s*(\{[^\r\n]*\})/.exec(text);
  if (!match) throw new Error("Reviewer did not return SOXU_REVIEW_RESULT");
  const result = JSON.parse(match[1]);
  if (typeof result.approved !== "boolean" || typeof result.summary !== "string") throw new Error("Invalid review schema");
  return result;
}

function safeEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  // Agent 会话标记：SOXU 的 pre-commit 会据此拒绝直接 git commit，
  // 强制改动留在工作区由 Runner 提交（否则会绕过 testedTree/reviewedTree 校验）。
  // 同时清掉提权标记，绝不让 Agent 继承 Runner 的提交权限。
  env.SOXU_AGENT_SESSION = "1";
  delete env.SOXU_ALLOW_COMMIT;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "ATOMGIT_TOKEN", "GIT_ASKPASS", "SSH_ASKPASS", "AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) delete env[key];
  // 删环境变量挡不住 gh：token 存在 keyring / hosts.yml 里（2026-11-02 实测 gh auth status 仍通过）。
  // 把 GH_CONFIG_DIR 指到一个空目录，Agent 侧的 gh 就是「未登录」，任何写操作都会失败。
  const isolated = process.env.SOXU_AGENT_GH_CONFIG_DIR || join(tmpdir(), "soxu-agent-gh-config-empty");
  try { mkdirSync(isolated, { recursive: true }); } catch { /* 目录不可用时 gh 同样没有凭据，安全方向不变 */ }
  env.GH_CONFIG_DIR = isolated;
  return env;
}

/** Kill subprocess descendants as well: a Pi turn can leave bash/compiler children running. */
function stopTree(child, hard = false) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (hard) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => {});
      killer.unref();
    } else { try { child.kill(); } catch {} }
  } else {
    try { process.kill(-child.pid, hard ? "SIGKILL" : "SIGTERM"); }
    catch { try { child.kill(hard ? "SIGKILL" : "SIGTERM"); } catch {} }
  }
}

export function piArgv(modelSelection, readOnly = false, intakeReadTools = false, webResearch = false) {
  if (intakeReadTools && !readOnly) throw new Error("Intake tools require the read-only profile");
  if (webResearch && !readOnly) throw new Error("Web research requires the read-only profile");
  // webResearch：只读仓库工具 + 联网调研。不禁 extensions（web 工具由扩展提供），
  // 但用 --tools 白名单把可调用范围钉死在这六个工具上。
  const profile = webResearch
    ? ["--tools", "read,grep,find,ls,web_search,fetch_content", "--no-mcp", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files"]
    : intakeReadTools
    ? ["--tools", "read,grep,find,ls", "--no-extensions", "--no-mcp", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files"]
    : readOnly ? ["--no-tools", "--no-extensions", "--no-mcp", "--no-session"] : [];
  return ["--mode", "rpc", ...profile, ...modelArgs(modelSelection)];
}

export function resolvePiTimeouts({ timeoutMs, timeouts = {} } = {}) {
  const hardMs = timeoutMs ?? (timeouts.piHardMinutes ?? 35) * 60000;
  const startupMs = Math.min(hardMs, (timeouts.piStartupSeconds ?? 90) * 1000);
  const baseIdleMs = Math.min(hardMs, (timeouts.piIdleSeconds ?? 240) * 1000);
  const graceMs = Math.min((timeouts.shutdownGraceSeconds ?? 5) * 1000, 10000);
  if (![hardMs,startupMs,baseIdleMs,graceMs].every(Number.isFinite) || hardMs < 30 || startupMs < 1 || baseIdleMs < 1 || graceMs < 0) throw new Error("Invalid Pi timeouts");
  return { hardMs, startupMs, baseIdleMs, graceMs };
}

/**
 * Two-stage inactivity + hard-deadline budget. Any recognized RPC activity extends
 * the idle window but never the hard deadline. Quota/network errors are returned
 * to the coordinator; this function never automatically replays a paid prompt.
 */
export async function runPi({ cwd, prompt, timeoutMs, timeouts, onEvent = () => {}, signal, modelSelection, readOnly = false, intakeReadTools = false, webResearch = false, env = {},
  idleExtensionSeconds = IDLE_EXTENSION_DEFAULT_SECONDS, slowCommandPrefixes = SLOW_COMMAND_DEFAULTS } = {}) {
  const extensionSeconds = idleExtensionSeconds;
  const prefixes = slowCommandPrefixes;
  const budgets = resolvePiTimeouts({ timeoutMs, timeouts });
  const binary = process.env.SOXU_PI_BIN || "pi";
  const win = process.platform === "win32";
  if (win && !/^[a-zA-Z0-9_-]+$/.test(binary)) throw new Error("SOXU_PI_BIN on Windows must be a safe executable name");
  const argv = piArgv(modelSelection, readOnly, intakeReadTools, webResearch);
  // Windows .cmd resolution requires cmd.exe; identifiers are strictly validated above.
  const child = spawn(win ? "cmd.exe" : binary, win ? ["/d", "/s", "/c", `${binary} ${argv.join(" ")}`] : argv, {
    cwd, env: safeEnvironment(env), windowsHide: true, detached: !win, stdio: ["pipe", "pipe", "pipe"]
  });
  const decoder = new StringDecoder("utf8");
  let stderr = "", text = "", finalAssistant = "", accepted = false, settled = false, handled = false, finished = false, closed = false;
  let terminationError = null, completedResult = null;
  let lastActivity = Date.now();
  const startedAt = lastActivity;
  const id = `soxu-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return await new Promise((resolve, reject) => {
    // 延时申请：idle 预算可被慢命令（cargo build/test 等）临时抬高。见 idle-extension.mjs。
    let idleMs = budgets.baseIdleMs;
    const watchdog = setInterval(() => {
      if (finished) return;
      const now = Date.now();
      const elapsed = now - startedAt;
      if (elapsed >= budgets.hardMs) return fail(new LoopFailure("timeout", `Pi hard deadline exceeded (${Math.round(budgets.hardMs / 1000)}s)`));
      if (!accepted && elapsed >= budgets.startupMs) return fail(new LoopFailure("timeout", `Pi startup/accept timeout (${Math.round(budgets.startupMs / 1000)}s)`));
      if (accepted && now - lastActivity >= idleMs) return fail(new LoopFailure("timeout", `Pi inactive for ${Math.round(idleMs / 1000)}s${idleMs > budgets.baseIdleMs ? "（含慢命令延时）" : ""}`));
    }, Math.min(250, budgets.startupMs, budgets.baseIdleMs, budgets.hardMs));
    let hardKillTimer;
    const onAbort = () => fail(new LoopFailure("interrupted", "Pi run interrupted; worktree preserved"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const framer = new LineFramer(msg => {
      // Only structured Pi events count as meaningful progress, not stderr noise.
      lastActivity = Date.now();
      // 延时申请批准点：工具启动时判定命令是否命中慢命令白名单。
      if (msg.type === "tool_execution_start" && idleBudgetFor) {
        const command = extractCommand(msg.args);
        if (command) {
          const granted = idleBudgetFor({ command, baseIdleMs: budgets.baseIdleMs, extensionSeconds, hardMs: budgets.hardMs, prefixes });
          if (granted !== idleMs) {
            idleMs = granted;
            onEvent({ type: "soxu:idle_extension", grantedMs: granted, commandPreview: command.slice(0, 120) });
          }
        }
      }
      onEvent(msg);
      if (msg.type === "response" && msg.id === id) {
        if (!msg.success) return fail(classifyFailure(new Error(`Pi rejected prompt: ${JSON.stringify(msg.error ?? "unknown")}`)));
        accepted = true;
        handled = msg.data?.disposition === "handled";
        maybeDone();
      }
      if (msg.type === "error" || msg.type === "agent_error") {
        return fail(classifyFailure(new Error(`Pi runtime error: ${JSON.stringify(msg.error ?? msg.message ?? msg)}`)));
      }
      if (msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta") {
        text = (text + String(msg.assistantMessageEvent.delta ?? "")).slice(-120000);
      }
      if (msg.type === "message_end" && msg.message?.role === "assistant") {
        const m = msg.message;
        if (m.stopReason === "error" || m.stopReason === "aborted" || m.errorMessage) {
          return fail(m.stopReason === "aborted" ? new LoopFailure("interrupted", "Pi turn aborted; worktree preserved") : classifyFailure(new Error(`Pi assistant error: ${m.errorMessage ?? m.stopReason}`)));
        }
        const blocks = m.content;
        if (Array.isArray(blocks)) finalAssistant = blocks.filter(c => c?.type === "text").map(c => c.text ?? "").join("\n").slice(-120000);
      }
      if (msg.type === "agent_settled") { settled = true; maybeDone(); }
    });
    child.stdout.on("data", chunk => {
      try { framer.push(decoder.write(chunk)); } catch (e) { fail(e); }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-12000); });
    child.on("error", fail);
    child.on("close", (code, exitSignal) => {
      closed = true;
      clearTimeout(hardKillTimer);
      if (terminationError) return settle(terminationError);
      if (completedResult) return settle(null, completedResult);
      settle(classifyFailure(new Error(`Pi exited before settled: ${code}/${exitSignal}\n${stderr.slice(-2000)}`)));
    });
    function maybeDone() { if (accepted && (settled || handled)) done(); }
    function cleanup() { clearInterval(watchdog); signal?.removeEventListener("abort", onAbort); }
    function settle(error, value) {
      if (finished) return;
      finished = true;
      cleanup();
      clearTimeout(hardKillTimer);
      error ? reject(classifyFailure(error)) : resolve(value);
    }
    function scheduleHardKill() {
      if (closed) return;
      hardKillTimer = setTimeout(() => {
        if (closed) return;
        stopTree(child, true);
        // Do not wait indefinitely for a broken process or taskkill to exit.
        hardKillTimer = setTimeout(() => settle(new LoopFailure("timeout", "Pi subprocess did not exit after forced termination")), 3000);
      }, budgets.graceMs);
    }
    function done() {
      if (finished || completedResult || terminationError) return;
      cleanup();
      completedResult = { text: finalAssistant || text, stderr, handled };
      try { child.stdin.end(); } catch {}
      // agent_settled is not process exit. Await close before launching checks:
      // Pi / tool descendants must not keep editing the Worktree afterward.
      if (closed) settle(null, completedResult);
      else scheduleHardKill();
    }
    function fail(error) {
      if (finished || terminationError) return;
      terminationError = classifyFailure(error);
      cleanup();
      try { child.stdin.write(JSON.stringify({ type: "abort" }) + "\n"); child.stdin.end(); } catch {}
      stopTree(child);
      if (closed) settle(terminationError);
      else scheduleHardKill();
    }
    if (signal?.aborted) return onAbort();
    try { child.stdin.write(JSON.stringify({ id, type: "prompt", message: prompt }) + "\n"); } catch (e) { fail(e); }
  });
}
