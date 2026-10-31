/**
 * Dashboard HTTP 服务器：静态资源、鉴权、SSE 与 /api/* 路由。
 *
 * 从原 dashboard.mjs 拆分（2026-11-02）：
 * - 协调器（Runner 所有权、快照聚合）→ dashboard-coordinator.mjs；
 * - 令牌/Host/锁/脱敏工具 → dashboard-utils.mjs；
 * - 本文件只剩路由与响应安全头。对外导出保持兼容（下游测试与 cli 仍从这里 import）。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, TOOL_ROOT } from "./config.mjs";
import { getPiModels, saveModelSettings } from "./model-settings.mjs";
import { readLatestReport, listReports, readReport, deleteReports } from "./dashboard-advisory.mjs";
import { DashboardCoordinator } from "./dashboard-coordinator.mjs";
import { allowedHosts, isLoopbackHost, tokenMatches, isValidToken, dashboardToken } from "./dashboard-utils.mjs";

// 对外导出保持原 dashboard.mjs 的形状（测试与 dashboard-cli.mjs 依赖它们）。
export { dashboardToken, isValidToken, isLoopbackHost, allowedHosts };
export { DashboardCoordinator };

export const DASHBOARD_PORT = 47321;
const MAX_STREAM_CLIENTS = 8;
const WEB_DIR = join(TOOL_ROOT, "automation", "loop", "web");
const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
// 按域拆分后的 12 个片段（2026-11-02，原 app.js 2074 行）。顺序即加载顺序。
for (const name of ["base", "infra", "logs", "render", "stream", "copy", "theme", "drafts", "nav", "models", "publish", "boot"]) {
  ASSETS.set("/js/app-" + name + ".js", ["js/app-" + name + ".js", "text/javascript; charset=utf-8"]);
}

async function readBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk.toString("utf8");
    if (Buffer.byteLength(raw) > 40000) throw Object.assign(new Error("body-too-large"), { status: 413 });
  }
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error("invalid-json"), { status: 400 }); }
}

export function createDashboardServer({ root = ROOT, token, bindHost = "127.0.0.1", coordinator = new DashboardCoordinator({ root }), restart = null } = {}) {
  if (!isValidToken(token)) throw new Error("Invalid dashboard token: 8-128 printable characters without spaces");
  const streamClients = new Set();
  let heartbeat = null, catalogPromise = null;
  const release = response => {
    streamClients.delete(response);
    if (streamClients.size === 0 && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  const sendFrame = (response, type, data) => {
    if (response.destroyed || response.writableEnded) return release(response);
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    try {
      if (!response.write(frame)) { // Drop a slow reader; never buffer unbounded event frames.
        release(response);
        response.destroy();
      }
    } catch {
      release(response);
      response.destroy();
    }
  };
  const onEvent = event => {
    for (const response of streamClients) sendFrame(response, event.type, event.data);
  };
  coordinator.on("dashboard:event", onEvent);
  const stopStreams = () => {
    for (const response of streamClients) response.end();
    streamClients.clear();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    coordinator.off("dashboard:event", onEvent);
  };
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const port = server.address()?.port;
    const hosts = allowedHosts(bindHost, port);
    // Host is allowlisted above, so it always carries the port.
    const base = `http://${request.headers.host}`;
    const reply = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const peer = request.socket.remoteAddress;
    const peerIsLoopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    // Loopback binding stays loopback-only; a LAN binding accepts LAN peers but still
    // requires an allowlisted Host header, so DNS rebinding cannot reach the API.
    if (!hosts.has(request.headers.host ?? "") || (isLoopbackHost(bindHost) && !peerIsLoopback)) {
      return reply(403, { error: "invalid-host" });
    }
    const originAllowed = value => {
      if (typeof value !== "string") return false;
      const match = /^http:\/\/([^/]+)$/.exec(value);
      return Boolean(match) && hosts.has(match[1]);
    };
    if (request.headers.origin && !originAllowed(request.headers.origin)) return reply(403, { error: "invalid-origin" });
    if (request.method === "GET" && request.url === "/favicon.ico") {
      response.writeHead(204);
      return response.end();
    }
    if (request.method === "GET" && ASSETS.has(request.url)) {
      const [filename, type] = ASSETS.get(request.url);
      try {
        response.writeHead(200, { "Content-Type": type });
        return response.end(await readFile(join(WEB_DIR, filename)));
      } catch { return reply(503, { error: "ui-unavailable" }); }
    }
    if (!tokenMatches(request.headers["x-soxu-control-token"], token)) return reply(401, { error: "unauthorized" });
    if (request.method === "GET" && request.url === "/api/events") {
      if (streamClients.size >= MAX_STREAM_CLIENTS) return reply(429, { error: "too-many-streams" });
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      streamClients.add(response);
      response.once("close", () => release(response));
      response.once("error", () => release(response));
      sendFrame(response, "hello", { instanceId: coordinator.instanceId });
      if (!heartbeat) {
        heartbeat = setInterval(() => {
          for (const client of streamClients) {
            if (client.destroyed || client.writableEnded || !client.write(": ping\n\n")) {
              release(client);
              client.destroy();
            }
          }
        }, 15000);
        heartbeat.unref?.();
      }
      return;
    }
    if (request.method === "GET" && ["/api/advisory-report?lane=product", "/api/advisory-report?lane=quality"].includes(request.url)) {
      try { return reply(200, {report:await readLatestReport(root, request.url.endsWith("product") ? "product" : "quality")}); }
      catch { return reply(503, {error:"report-unavailable"}); }
    }
    if (request.method === "GET" && request.url.startsWith("/api/advisory-reports?")) {
      try { const query=new URL(request.url,base).searchParams, lane=query.get("lane"), name=query.get("name");
        if ([...query.keys()].some(k=>!['lane','name'].includes(k)) || query.getAll('lane').length!==1 || query.getAll('name').length>1) return reply(400,{error:"invalid-query"});
        return reply(200,name === null ? {reports:await listReports(root,lane)} : {report:await readReport(root,lane,name)});
      } catch(error) {return reply(error.status ?? 503,{error:error.status ? error.message : "report-unavailable"});}
    }
    if (request.method === "GET" && request.url === "/api/model-catalog") {
      try {
        catalogPromise ??= getPiModels(root).finally(()=>{catalogPromise=null;});
        return reply(200,await catalogPromise);
      } catch {return reply(503,{error:"model-list-unavailable"});}
    }
    if (request.method === "GET" && request.url === "/api/status") {
      try { return reply(200, await coordinator.snapshot()); }
      catch { return reply(503, { error: "status-unavailable" }); }
    }
    if (request.method === "POST" && ["/api/run", "/api/stop", "/api/merge", "/api/auto-merge", "/api/update", "/api/publish", "/api/intake-assess", "/api/intake-submit", "/api/intake-clear", "/api/queue-reorder", "/api/queue-ready", "/api/drafts-save", "/api/drafts-move", "/api/drafts-reorder", "/api/drafts-ready", "/api/drafts-remove", "/api/drafts-assess", "/api/drafts-answer", "/api/drafts-batch", "/api/drafts-resolve", "/api/drafts-reassess", "/api/advisory-run", "/api/advisory-delete", "/api/model-settings"].includes(request.url)) {
      if (!request.headers.origin || !originAllowed(request.headers.origin) || request.headers["content-type"] !== "application/json") {
        return reply(403, { error: "invalid-request-origin" });
      }
      try {
        const body = await readBody(request);
        if (request.url === "/api/model-settings") {
          try {const settings=await saveModelSettings(body,root);return reply(200,{settings});}
          catch(error){return reply(error.status ?? 400,{error:error.status ? error.message : "invalid-model-settings"});}
        }
        if (request.url === "/api/publish") {
          if (!body || Object.keys(body).sort().join(",") !== "mode" || !["preview", "release"].includes(body.mode)) return reply(400, { error: "invalid-body" });
          try { return reply(200, await coordinator.publishVersion(body.mode)); }
          catch (error) { return reply(error.status ?? 409, { error: error.message, details: error.details ?? null }); }
        }
        if (request.url === "/api/update") {
          if (!body || Object.keys(body).sort().join(",") !== "action" || !["check", "apply"].includes(body.action)) return reply(400, { error: "invalid-body" });
          if (body.action === "check") return reply(200, await coordinator.refreshUpdate({ force: true }));
          // Allowed while a runner is active: loaded modules keep running, only new
          // processes see the updated checkout.
          const result = await coordinator.applyUpdate();
          if (result.status === "updated" && typeof restart === "function") {
            // Applying new code only helps the next process: hand the request over and
            // let the caller restart this dashboard (running tasks are detached).
            setTimeout(() => { Promise.resolve(restart()).catch(error => console.error("dashboard restart failed: " + (error?.message ?? error))); }, 150);
            return reply(200, { ...result, restarting: true });
          }
          return reply(result.status === "updated" || result.status === "up-to-date" ? 200 : 409, result);
        }
        if (request.url === "/api/advisory-delete") {
          if (!body || Object.keys(body).sort().join(",") !== "lane,name" || typeof body.lane!=="string" || !(body.name===null || typeof body.name==="string")) return reply(400,{error:"invalid-body"});
          const result=await deleteReports(root,body.lane,body.name);
          coordinator.lanesNext=0; coordinator.emit("dashboard:event",{type:"status",data:{}});
          return reply(200,result);
        }
        if (request.url === "/api/advisory-run") {
          if (!body || Object.keys(body).join(",") !== "lane" || typeof body.lane !== "string") return reply(400,{error:"invalid-body"});
          return reply(202, coordinator.advisory.start(body.lane));
        }
        // 注意：keys 在下面的 drafts 分支里才声明，这里必须自己算，否则会抛
        // ReferenceError 并被兜底成 503 operation-failed。
        if (request.url === "/api/queue-reorder") {
          if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "invalid-body" });
          if (Object.keys(body).sort().join(",") !== "order" || !Array.isArray(body.order)) return reply(400, { error: "invalid-body" });
          return reply(200, await coordinator.reorderQueue(body.order));
        }
        if (request.url === "/api/queue-ready") {
          if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "invalid-body" });
          if (Object.keys(body).sort().join(",") !== "number,ready") return reply(400, { error: "invalid-body" });
          return reply(200, await coordinator.setQueueReady(body.number, body.ready === true));
        }
        if (request.url.startsWith("/api/drafts-")) {
          if (!body || typeof body!=="object" || Array.isArray(body)) return reply(400,{error:"invalid-body"});
          const keys=Object.keys(body).sort().join(","); let result;
          if(request.url==="/api/drafts-save" && keys==="id,requirement") result=await coordinator.drafts.save(body);
          else if(request.url==="/api/drafts-move" && keys==="direction,id") result=await coordinator.drafts.move(body.id,body.direction);
          else if(request.url==="/api/drafts-reorder" && keys==="beforeId,id") result=await coordinator.drafts.reorder(body.id,body.beforeId);
          else if(request.url==="/api/drafts-ready" && keys==="id,ready") result=await coordinator.drafts.setReady(body.id,body.ready===true);
          else if(request.url==="/api/drafts-remove" && keys==="id") result=await coordinator.drafts.remove(body.id);
          else if(request.url==="/api/drafts-assess" && keys==="id") result=await coordinator.drafts.evaluate(body.id);
          else if(request.url==="/api/drafts-answer" && keys==="answers,id,milestone,ready") result=await coordinator.drafts.answer(body.id,body.answers,body.ready,body.milestone);
          else if(request.url==="/api/drafts-batch" && keys==="ids") result=await coordinator.drafts.batch(body.ids);
          else if(request.url==="/api/drafts-resolve" && keys==="created,id,url") result=await coordinator.drafts.resolve(body.id,body.created,body.url);
          else if(request.url==="/api/drafts-reassess" && keys==="id") result=await coordinator.drafts.reassess(body.id);
          else return reply(400,{error:"invalid-body"});
          return reply(200,result);
        }
        if (request.url === "/api/intake-assess") {
          if (!body || Object.keys(body).join(",") !== "requirement") return reply(400,{error:"invalid-body"});
          return reply(202, await coordinator.intake.start(body.requirement));
        }
        if (request.url === "/api/intake-clear") {
          if (!body || Object.keys(body).join(",") !== "id" || typeof body.id !== "string") return reply(400,{error:"invalid-body"});
          return reply(200, await coordinator.intake.clearUnknown(body.id));
        }
        if (request.url === "/api/intake-submit") return reply(409,{error:"use-draft-confirmation"});
        if (request.url === "/api/run") {
          if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.command !== "string")
            return reply(400, { error: "invalid-command" });
          // Per-task recovery is gone: "start" handles paused and blocked uniformly.
          if (Object.keys(body).length !== 1) return reply(400, { error: "invalid-command" });
          return reply(202, await coordinator.start(body.command));
        }
        if (request.url === "/api/merge") {
          if (!body || Object.keys(body).sort().join(",") !== "issue,pr") return reply(400, {error:"invalid-body"});
          return reply(200, await coordinator.merge(body.issue, body.pr));
        }
        if (request.url === "/api/auto-merge") {
          if (!body || Object.keys(body).join(",") !== "enabled") return reply(400, {error:"invalid-body"});
          return reply(200, coordinator.setAutoMerge(body.enabled));
        }
        if (!body || typeof body !== "object" || Object.keys(body).length !== 0)
          return reply(400, { error: "invalid-body" });
        return reply(202, coordinator.stop());
      } catch (error) {
        return reply(error.status ?? 503, { error: error.status ? error.message : "operation-failed" });
      }
    }
    return reply(404, { error: "not-found" });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return { server, coordinator, stopStreams };
}
