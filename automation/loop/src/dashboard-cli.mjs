#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const { server, coordinator, stopStreams } = createDashboardServer({ token, bindHost: host });
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
