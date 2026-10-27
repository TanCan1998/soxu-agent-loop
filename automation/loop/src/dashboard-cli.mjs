#!/usr/bin/env node
import { DASHBOARD_PORT, dashboardToken, createDashboardServer } from "./dashboard.mjs";

const token = dashboardToken();
const { server, coordinator, stopStreams } = createDashboardServer({ token });
server.once("error", error => {
  console.error(`SOXU dashboard failed: ${error.code ?? "unknown"}`);
  process.exitCode = 1;
});
server.listen(DASHBOARD_PORT, "127.0.0.1", () => {
  console.log(`SOXU local dashboard: http://127.0.0.1:${DASHBOARD_PORT}/`);
  console.log(`Session token (keep private): ${token}`);
  console.log("Open browser, paste token. Only jobs started here can be stopped here. Ctrl+C exits.");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { coordinator.shutdown(); stopStreams(); server.close(); });
}
