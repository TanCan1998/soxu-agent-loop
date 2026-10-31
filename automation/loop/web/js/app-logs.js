/** app-logs.js：/api 请求封装、实例重置、日志合并与渲染、过滤器。 */
async function api(path, options = {}, token = tokenInput.value.trim()) {
  if (!validToken(token)) throw new Error("请填写启动窗口显示的令牌（8–128 位，不含空格）。");
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "X-SOXU-Control-Token": token, ...(options.method ? { "Content-Type": "application/json" } : {}) },
    ...(options.method ? { body: JSON.stringify(options.body ?? {}) } : {}),
    cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(path === "/api/intake-submit" ? 55000 : path === "/api/model-catalog" ? 35000 : 9000)
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "HTTP " + response.status);
    error.status = response.status;
    throw error;
  }
  return data;
}

function resetInstance(next) {
  if (instanceId === next) return;
  instanceId = next;
  latestSequence = 0;
  logs = [];
  agents.clear();
  actualModels.clear();
  lastAgentKey = "";
  lastTaskKey = "";
  renderedLogKey = "";
  lastIntakeKey = ""; lastQueueKey = ""; lastRoadmapKey = "";
}
function mergeLog(line) {
  if (!line || !Number.isSafeInteger(line.seq) || !["system", "stdout", "stderr"].includes(line.stream)
      || typeof line.message !== "string" || typeof line.time !== "string") return;
  if (line.seq <= latestSequence) return;
  if (latestSequence && line.seq > latestSequence + 1) void refresh();
  latestSequence = line.seq;
  logs.push(line);
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  renderLogs();
}
function rebuildLogs(items) {
  const incoming = Array.isArray(items) ? items : [];
  const last = incoming.at(-1)?.seq ?? 0;
  if (last < latestSequence) return;
  if (last === latestSequence && logs.length && incoming.length === logs.length) return;
  logs = incoming.filter(item => item && Number.isSafeInteger(item.seq)
    && ["system","stdout","stderr"].includes(item.stream)).slice(-500);
  latestSequence = last;
  renderLogs(true);
}
function visibleLogs() {
  return logs.filter(item => logFilter === "all" || item.stream === logFilter).slice(-logLimit);
}
function logElement(entry) {
  const line = element("div", undefined, "log");
  line.dataset.stream = entry.stream;
  line.dataset.seq = String(entry.seq);
  line.append(element("span", new Date(entry.time).toLocaleTimeString(), "time"), document.createTextNode(entry.message));
  return line;
}
function renderLogs(force = false) {
  const container = $("logs");
  const rows = visibleLogs();
  const key = logFilter + ":" + logLimit + ":" + (rows[0]?.seq ?? 0) + ":" + (rows.at(-1)?.seq ?? 0) + ":" + rows.length;
  if (!force && key === renderedLogKey) return;
  const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 35;
  if (rows.length === 0) {
    container.replaceChildren(element("div", "暂无符合条件的日志", "empty"));
  } else {
    const previous = container.lastElementChild;
    const lastSeq = Number(previous?.dataset?.seq);
    const appendOne = !force && previous && previous.classList.contains("log")
      && rows.length > 1 && rows.at(-2).seq === lastSeq;
    if (appendOne) {
      container.append(logElement(rows.at(-1)));
      while (container.children.length > rows.length) container.firstElementChild.remove();
    } else {
      container.replaceChildren(...rows.map(logElement));
    }
  }
  renderedLogKey = key;
  $("logCount").textContent = rows.length + " / " + logs.length + " 条";
  if (followLogs && wasAtBottom) container.scrollTop = container.scrollHeight;
}
/* ---------- 列表状态筛选：全部 | 进行中 | 已完成 ---------- */
const listFilters = { tasks: "all", drafts: "all", milestone: "all" };
const FILTER_LABELS = [["all", "全部"], ["active", "进行中"], ["done", "已完成"]];
let lastSnapshot = null;
const taskDone = task => task.status === "done";
const draftDone = draft => draft.status === "submitted";
function passesFilter(filter, done) {
  return filter === "all" ? true : filter === "done" ? done : !done;
}
function renderFilterBar(hostId, key, onPick, counts) {
  const host = $(hostId);
  if (!host) return;
  host.replaceChildren();
  for (const [value, label] of FILTER_LABELS) {
    const button = element("button", label + (counts ? " · " + counts[value] : ""), "filter");
    button.type = "button";
    button.dataset.filter = value;
    button.setAttribute("aria-pressed", String(listFilters[key] === value));
    button.addEventListener("click", () => {
      if (listFilters[key] === value) return;
      listFilters[key] = value;
      onPick();
    });
    host.append(button);
  }
}
// 列表分页上限：压测显示 500 个任务渲染只要 5ms，但 3746 个 DOM 节点会让滚动变卡。
// 真正的瓶颈是节点数，所以按页渲染，而不是优化渲染函数本身。
const LIST_PAGE_SIZE = 50;
const listPageSize = { tasks: LIST_PAGE_SIZE, queue: LIST_PAGE_SIZE };
