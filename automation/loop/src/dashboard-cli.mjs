#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { DASHBOARD_PORT, dashboardToken, createDashboardServer, isLoopbackHost } from "./dashboard.mjs";
import { networkInterfaces } from "node:os";
import { TOOL_ROOT, ROOT, PROJECT_ROOT_SOURCE } from "./config.mjs";

/** Optional local override file (gitignored): { "host": "0.0.0.0", "port": 47321, "token": "..." } */
function localConfig() {
  try { return JSON.parse(readFileSync(join(TOOL_ROOT, "dashboard.config.json"), "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw new Error("dashboard.config.json is not valid JSON"); }
}
const file = localConfig();
const host = (process.env.SOXU_DASHBOARD_HOST ?? file.host ?? "127.0.0.1").trim();
const port = Number(process.env.SOXU_DASHBOARD_PORT ?? file.port ?? DASHBOARD_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SOXU_DASHBOARD_PORT must be 1..65535");
const token = (process.env.SOXU_DASHBOARD_TOKEN ?? file.token ?? "").trim() || dashboardToken();

/** Health probe used to decide whether the replacement process took over. */
async function healthy() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { "x-soxu-control-token": token }, signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch { return false; }
}

let relaunching = false;
/**
 * Hand the port over to a fresh process so updated server code takes effect. Detached
 * runners survive (they record themselves in .soxu/runner/state.json and are adopted).
 * If the replacement never answers, the previous listener comes back instead of
 * leaving the operator with nothing.
 */
async function relaunch() {
  if (relaunching) return;
  relaunching = true;
  console.log("Restarting dashboard to load the updated tool code...");
  stopStreams();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SOXU_PROJECT_ROOT: ROOT,
      SOXU_DASHBOARD_HOST: host,
      SOXU_DASHBOARD_PORT: String(port),
      SOXU_DASHBOARD_TOKEN: token,
    },
  });
  child.unref();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(300);
    if (await healthy()) { console.log("Replacement dashboard is ready; exiting the old process."); process.exit(0); }
    if (child.exitCode !== null) break;
  }
  server.listen(port, host);
  relaunching = false;
  throw new Error("replacement dashboard did not become ready; kept the previous process");
}

const { server, coordinator, stopStreams } = createDashboardServer({ token, bindHost: host, restart: relaunch });
server.once("error", error => {
  console.error(`SOXU dashboard failed: ${error.code ?? "unknown"}`);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`Project: ${ROOT}${PROJECT_ROOT_SOURCE === "sibling" ? " (sibling checkout; set SOXU_PROJECT_ROOT to override)" : ""}`);
  if (isLoopbackHost(host)) {
    console.log(`SOXU local dashboard: http://127.0.0.1:${port}/`);
  } else {
    console.log(`SOXU dashboard bound to ${host}:${port} — reachable from the LAN:`);
    for (const list of Object.values(networkInterfaces())) {
      for (const nic of list ?? []) {
        if (nic.internal) continue;
        const address = nic.family === "IPv4" ? nic.address : `[${nic.address}]`;
        console.log(`  http://${address}:${port}/`);
      }
    }
    console.log("WARNING: anyone who can reach this port and knows the token can start/stop runs, merge PRs and change model settings. Use a long random token on a trusted network only.");
  }
  console.log(`Session token (keep private): ${token}`);
  console.log("Open browser, paste token. Only jobs started here can be stopped here. Ctrl+C exits.");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { coordinator.shutdown(); stopStreams(); server.close(); });
}
