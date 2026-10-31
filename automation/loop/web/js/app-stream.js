/** app-stream.js：SSE 事件流——连接、心跳、断线重连与事件分发。 */
async function refresh() {
  const token = tokenInput.value.trim();
  if (requestInFlight || document.hidden || !token) return;
  requestInFlight = true;
  try {
    const data = await api("/api/status", {}, token);
    if (token !== tokenInput.value.trim()) return;
    const wasConnected = connected;
    render(data);
    persistToken(token);
    if (!wasConnected) notice("连接成功；页面将实时更新，刷新后自动恢复。");
    if (!streamController && !reconnectTimer) void openStream(token);
  } catch (error) {
    if (token !== tokenInput.value.trim()) return;
    if (error.status === 401) {
      lostAuthorization(token);
    } else {
      connected = false;
      $("authPanel").hidden = false;
      $("globalRun").dataset.status="unknown"; $("globalRun").textContent="状态未知";
      disableControls();
      notice("连接失败：" + error.message);
    }
  } finally { requestInFlight = false; }
}

function stopStream() {
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (streamController) streamController.abort();
  streamController = null;
  streamToken = null;
  retries = 0;
}
function onStreamEvent(type, data) {
  if (type === "hello") {
    if (data.instanceId && instanceId && data.instanceId !== instanceId) void refresh();
  } else if (type === "log") {
    mergeLog(data);
  } else if (type === "agent") {
    if (!data || !Number.isSafeInteger(data.taskId) || !["developer","reviewer"].includes(data.role)) return;
    agents.set(data.taskId + ":" + data.role, data);
    if (agents.size > 32) agents.delete(agents.keys().next().value);
    renderAgents();
  } else if (type === "status") {
    void refresh();
  }
}
function consumeSseFrame(frame) {
  let kind = "message", payload = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) kind = line.slice(6).trim();
    else if (line.startsWith("data:")) payload += line.slice(5).trimStart();
  }
  if (!payload || !["hello","log","agent","status"].includes(kind)) return;
  try { onStreamEvent(kind, JSON.parse(payload)); } catch {}
}
async function openStream(token) {
  if (streamController || typeof AbortController === "undefined") return;
  const controller = new AbortController();
  streamController = controller;
  streamToken = token;
  let reader = null;
  try {
    const response = await fetch("/api/events", {
      headers: { "X-SOXU-Control-Token": token },
      cache: "no-store", credentials: "omit", signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error("SSE HTTP " + response.status);
      error.status = response.status;
      throw error;
    }
    if (!response.body?.getReader) return; // Keep periodic HTTP calibration in limited environments.
    retries = 0;
    const decoder = new TextDecoder();
    reader = response.body.getReader();
    let buffer = "";
    while (!controller.signal.aborted) {
      const result = await reader.read();
      if (result.done) break;
      buffer = (buffer + decoder.decode(result.value, { stream: true })).replace(/\r\n/g, "\n");
      let offset;
      while ((offset = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, offset);
        buffer = buffer.slice(offset + 2);
        consumeSseFrame(frame);
      }
      if (buffer.length > 65536) throw new Error("事件帧超限");
    }
  } catch (error) {
    if (!controller.signal.aborted && token === tokenInput.value.trim() && error.status === 401) {
      lostAuthorization(token);
      return;
    }
  } finally {
    // Close the response even when framing fails or the body is unsupported.
    // Otherwise a reconnect can leave the previous SSE request alive indefinitely.
    const reconnect = !controller.signal.aborted;
    controller.abort();
    if (reader) {
      try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
      try { reader.releaseLock(); } catch {}
    }
    if (streamController !== controller) return;
    streamController = null;
    streamToken = null;
    if (reconnect && token === tokenInput.value.trim() && connected) {
      retries = Math.min(retries + 1, 5);
      const wait = Math.min(15000, 750 * 2 ** retries) + Math.floor(Math.random() * 300);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (connected && !document.hidden) void openStream(token);
      }, wait);
    }
  }
}
/**
 * execCommand("copy") is the only option on a non-secure origin: Android Chrome over
 * plain HTTP on the LAN exposes no navigator.clipboard, so the modern API alone fails.
 */
