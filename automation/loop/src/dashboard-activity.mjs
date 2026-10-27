/**
 * Strictly bounded, metadata-only telemetry for dashboard-owned Pi RPC runs.
 * Never forward raw Pi records, prompts, tool arguments or model text to WebUI.
 */
const STATES = new Set(["waiting", "generating", "tool", "completed", "failed"]);
const ROLES = new Set(["developer", "reviewer"]);

export function safeActivity(message) {
  if (!message || typeof message !== "object") return null;
  const { taskId, role, state, tool, startedAt, activitySince } = message;
  if (!Number.isSafeInteger(taskId) || taskId <= 0 || taskId >= 1e9 ||
      !ROLES.has(role) || !STATES.has(state)) return null;
  const toolName = state === "tool" && typeof tool === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(tool)
    ? tool : null;
  const validDate = s => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s));
  if (!validDate(startedAt) || !validDate(activitySince)) return null;
  return { taskId, role, state, tool: toolName, startedAt, activitySince };
}

export function createPiActivityReporter(taskId, role, { send = message => {
  if (typeof process.send === "function" && process.connected) {
    try { process.send(message); } catch { /* Telemetry must never interrupt paid Pi work. */ }
  }
}, now = () => new Date().toISOString() } = {}) {
  if (!ROLES.has(role) || !Number.isSafeInteger(taskId) || taskId <= 0) throw new Error("Invalid Pi activity identity");
  const startedAt = now();
  let state = "", tool = null;
  const update = (next, nextTool = null) => {
    if (next === state && nextTool === tool) return;
    state = next;
    tool = nextTool;
    send({ type: "soxu:activity", data: {
      taskId, role, state, tool, startedAt, activitySince: now(),
    } });
  };
  const onEvent = event => {
    if (!event || typeof event.type !== "string") return;
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        update("waiting"); break;
      case "message_update":
        if (["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent?.type))
          update("generating");
        break;
      case "tool_execution_start":
        update("tool", typeof event.toolName === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(event.toolName) ? event.toolName : null);
        break;
      case "tool_execution_end":
      case "message_end":
        if (state === "tool" || state === "generating") update("waiting");
        break;
      case "agent_error":
      case "error":
        update("failed"); break;
      case "agent_end":
      case "agent_settled":
        update("completed"); break;
    }
  };
  update("waiting");
  return { onEvent, finish: success => update(success ? "completed" : "failed") };
}
