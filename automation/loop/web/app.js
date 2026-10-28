const $ = id => document.getElementById(id);
const tokenInput = $("token");
const TOKEN_STORAGE_KEY = "soxu.dashboard.sessionToken.v1";
const LOG_LIMIT_KEY = "soxu.dashboard.logLimit.v1";
const LOG_FILTER_KEY = "soxu.dashboard.logFilter.v1";
const PAGE_KEY = "soxu.dashboard.page.v1";
const THEME_KEY = "soxu.dashboard.theme.v1";
const FOLLOW_KEY = "soxu.dashboard.followLogs.v1";
const LOG_LIMITS = new Set([20, 50, 100, 200]);
const preferenceStorage = typeof localStorage === "undefined" ? { getItem: () => null, setItem: () => {} } : localStorage;
const stateLabels = { running: "进行中", paused: "已暂停", blocked: "已阻塞", pending: "等待", done: "本地已结束" };
const phaseLabels = {
  worktree:"准备工作树", install:"安装依赖", develop:"开发", checks:"执行检查", review:"代码审查",
  postConflictInstall:"冲突后安装", recoveryInstall:"恢复时安装依赖", finalChecks:"最终检查", commit:"提交", push:"推送",
  createPr:"创建 PR", merge:"等待合并", done:"完成"
};
const activityLabels = { waiting:"等待模型", generating:"生成中", tool:"执行工具", completed:"已完成", failed:"失败" };
let connected = false, requestInFlight = false;
let instanceId = null, latestSequence = 0, logs = [], lastTaskKey = "", renderedLogKey = "";
let agents = new Map(), lastAgentKey = "", streamController = null, streamToken = null, reconnectTimer = null, retries = 0;
let logLimit = 50, logFilter = "all", followLogs = true, currentIntake = null, lastIntakeKey = "", lastQueueKey = "";
let lastRoadmapKey = "";
let queueSnapshot = []; // 已创建需求（供分类计数复用）
let lastStatus = null;  // 最近一次快照，供分类切换时局部重绘
let advisoryState = null, loadedReportKeys = {product:"",quality:""}, currentReports = {product:null,quality:null};
let draftState = {items:[],busy:false}, editingDraft = null, selectedDrafts = new Set(), lastDraftKey = "";
let modelSettings = null, modelDraft = null, modelCatalog = [], actualModels = new Map();

function stored(storage, key) { try { return storage.getItem(key); } catch { return null; } }
function save(storage, key, value) { try { storage.setItem(key, String(value)); } catch {} }
/** sessionStorage 在部分安卓浏览器（如雨见）刷新后会被清空，所以优先读 localStorage。 */
function safeStorage(name) {
  try { const storage = globalThis[name]; return storage && typeof storage.getItem === "function" ? storage : null; }
  catch { return null; }
}
function restoreToken() {
  for (const storage of [safeStorage("localStorage"), safeStorage("sessionStorage")]) {
    if (!storage) continue;
    const token = stored(storage, TOKEN_STORAGE_KEY);
    if (token && validToken(token)) { persistToken(token); return token; }
    if (token) forgetToken(token);
  }
  return "";
}
function persistToken(token) {
  for (const storage of [safeStorage("localStorage"), safeStorage("sessionStorage")]) {
    if (storage) save(storage, TOKEN_STORAGE_KEY, token);
  }
}
/** Must stay in sync with the server: any 8-128 printable characters, no spaces. */
function validToken(value) {
  return typeof value === "string" && /^[\x21-\x7e]{8,128}$/.test(value);
}
function forgetToken(token) {
  for (const storage of [safeStorage("localStorage"), safeStorage("sessionStorage")]) {
    if (!storage) continue;
    try { if (storage.getItem(TOKEN_STORAGE_KEY) === token) storage.removeItem(TOKEN_STORAGE_KEY); } catch {}
  }
}
function notice(message) { $("notice").textContent = message; $("authNotice").textContent = message; }
/**
 * 统一确认弹窗：替代浏览器原生 await askConfirm()/await askText()，避免阻塞式弹窗与样式割裂。
 * 返回 Promise，调用方必须 await。
 */
function showConfirmDialog({ message, input = null, confirmText = "确认", danger = false }) {
  const dialog = $("confirmDialog");
  $("confirmMessage").textContent = message;
  $("confirmTitle").textContent = danger ? "确认高风险操作" : "确认操作";
  $("confirmInputLabel").hidden = input === null;
  $("confirmInput").hidden = input === null;
  $("confirmInput").value = input?.value ?? "";
  if (input) $("confirmInput").placeholder = input.placeholder ?? "";
  $("confirmAccept").textContent = confirmText;
  $("confirmAccept").className = danger ? "primary danger" : "primary";
  return new Promise(resolve => {
    const finish = value => {
      closeDialog(dialog);
      $("confirmAccept").removeEventListener("click", accept);
      $("confirmCancel").removeEventListener("click", cancel);
      dialog.removeEventListener("click", backdrop);
      resolve(value);
    };
    const accept = () => finish(input === null ? true : $("confirmInput").value.trim());
    const cancel = () => finish(input === null ? false : null);
    // 非输入性确认（askConfirm）：点击弹窗外即取消；输入性确认（askText）必须显式操作，
    // 避免误点丢掉已输入的内容。
    const backdrop = event => {
      if (input !== null) return;
      if (!clickedOutside(dialog, event)) return;
      cancel();
    };
    $("confirmAccept").addEventListener("click", accept);
    $("confirmCancel").addEventListener("click", cancel);
    dialog.addEventListener("click", backdrop);
    openDialog(dialog);
  });
}
/**
 * 统一关闭入口：先播退场动画再真正 close()。原生 dialog 的 close 是瞬时的，
 * 直接调用会让进场动画有"突然消失"的割裂感。
 */
function closeDialog(dialog) {
  if (!dialog) return;
  // 上一次退场没有收尾（动画事件丢失等）：立刻强制关闭，绝不让弹窗卡在
  // open + closing 状态——否则它既关不掉、又因为已 open 而无法再次打开。
  if (dialog.dataset.closing === "1") {
    delete dialog.dataset.closing;
    dialog.classList.remove("closing");
    if (dialog.open) { try { dialog.close(); } catch { /* already closed */ } }
    return;
  }
  if (!dialog.open) {
    delete dialog.dataset.closing;
    dialog.classList.remove("closing");
    return;
  }
  dialog.dataset.closing = "1";
  dialog.classList.add("closing"); // 让 ::backdrop 一起淡出
  let settled = false;
  let animation = null;
  const done = () => {
    if (settled) return;
    settled = true;
    // 必须取消动画：fill:"forwards" 会把元素永久留在 opacity:0，
    // 再次 showModal 时弹窗虽然 open 却完全透明（表现为"打不开"）。
    try { animation?.cancel(); } catch { /* already gone */ }
    dialog.classList.remove("closing");
    delete dialog.dataset.closing;
    if (dialog.open) { try { dialog.close(); } catch { /* already closed */ } }
  };
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  // 没有 Web Animations（旧浏览器/测试环境）时直接关闭，保证状态正确。
  if (reduce || typeof dialog.animate !== "function") return done();
  try {
    animation = dialog.animate(
      [{ opacity: 1, transform: "translateY(0) scale(1)", filter: "blur(0)" },
       { opacity: 0, transform: "translateY(8px) scale(.98)", filter: "blur(6px)" }],
      { duration: 200, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" },
    );
    // finished 在 top-layer 元素被移除或动画被打断时可能永不 resolve，用超时兜底。
    animation?.finished?.then(done, done);
    setTimeout(done, 260);
  } catch { done(); }
}
/** 统一打开入口：先清掉上一次退场残留，避免 showModal 抛 InvalidStateError。 */
function openDialog(dialog) {
  if (!dialog) return;
  delete dialog.dataset.closing;
  dialog.classList.remove("closing");
  // 取消残留的退场动画，否则元素会带着 opacity:0 的填充状态显示（看起来像没弹出来）。
  try { dialog.getAnimations?.().forEach(item => item.cancel()); } catch { /* no WAAPI */ }
  if (!dialog.open) dialog.showModal();
}
/**
 * 自绘滚动指示条。
 * overlay 滚动条环境（Android 浏览器/WebView、Chromium overlay 模式）会完全忽略
 * ::-webkit-scrollbar，所以这里用 DOM 指示条兜底，保证任何环境下视觉一致。
 */
const scrollIndicators = [];
function mountScrollIndicator(scroller = null) {
  const bar = document.createElement("div");
  bar.className = "scroll-thumb";
  document.body.appendChild(bar);
  let hideTimer = null;
  const sync = () => {
    // 指示条始终 fixed 定位：容器滚动时 rect 不变，滚动只改变 thumb 的偏移。
    const rect = scroller ? scroller.getBoundingClientRect() : { top: 0, right: window.innerWidth, height: document.documentElement.clientHeight };
    const top = scroller ? scroller.scrollTop : window.scrollY;
    const view = scroller ? scroller.clientHeight : document.documentElement.clientHeight;
    const total = scroller ? scroller.scrollHeight : document.documentElement.scrollHeight;
    const visibleArea = scroller ? rect.height : view;
    if (!Number.isFinite(view) || !Number.isFinite(total) || view <= 0) return;
    if (total <= view + 2 || visibleArea < 40) { bar.classList.remove("visible"); return; }
    const track = visibleArea - 8;
    const height = Math.max(28, Math.round(track * view / total));
    const offset = Math.round((track - height) * (top / (total - view)));
    bar.style.height = height + "px";
    bar.style.left = (rect.right - 10) + "px";
    bar.style.top = (rect.top + 4 + offset) + "px";
    bar.classList.add("visible", "active");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bar.classList.remove("active"), 900);
  };
  (scroller ?? window).addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync);
  scrollIndicators.push(sync);
  sync();
  return sync;
}
function mountScrollIndicators() {
  try {
    // 经典滚动条环境（桌面 Chrome/Edge）由 ::-webkit-scrollbar 负责，不重复画。
    if (window.innerWidth - document.documentElement.clientWidth > 0) return;
    mountScrollIndicator(null);
    for (const node of document.querySelectorAll(".model-groups")) mountScrollIndicator(node);
  } catch { /* 受限环境（无布局/测试桩）跳过，不影响页面逻辑 */ }
}
/** 弹窗开合会改变容器位置，重算一次指示条。 */
function refreshScrollIndicators() { for (const sync of scrollIndicators) sync(); }
/** 点击是否落在弹窗盒子之外（背板）。点击弹窗内边距不算外部，避免误关。 */
function clickedOutside(dialog, event) {
  if (event.target !== dialog) return false;
  const rect = dialog.getBoundingClientRect?.();
  if (!rect) return true;
  const { clientX: x, clientY: y } = event;
  return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
}
/** 非输入性弹窗：点击背板即关闭。 */
function dismissOnBackdrop(dialog, close) {
  dialog.addEventListener("click", event => {
    if (clickedOutside(dialog, event)) close();
  });
}
function askConfirm(message, options = {}) {
  return showConfirmDialog({ message, confirmText: options.confirmText ?? "确认", danger: options.danger === true });
}
function askText(message, placeholder = "") {
  return showConfirmDialog({ message, input: { value: "", placeholder }, confirmText: "确定" });
}

function element(tag, value, className) {
  const result = document.createElement(tag);
  if (value !== undefined) result.textContent = String(value);
  if (className) result.className = className;
  return result;
}
/**
 * 自绘 tooltip：替代原生 title 属性，跟随主题变量、支持键盘焦点。
 * 用法：元素 data-tip="文案"（静态）或 setTip(el, text)（动态，写入 data-tip）。
 */
const tipBox = () => $("tip");
function showTip(target) {
  const text = target?.dataset?.tip;
  if (!text) return hideTip();
  const tip = tipBox();
  tip.textContent = text;
  tip.hidden = false;
  const rect = target.getBoundingClientRect();
  const margin = 8;
  let left = rect.left + rect.width / 2 - tip.offsetWidth / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - tip.offsetWidth - margin));
  let top = rect.top - tip.offsetHeight - margin;
  if (top < margin) top = rect.bottom + margin; // 顶部放不下时翻到下方
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}
function hideTip() { const tip = tipBox(); tip.hidden = true; }
function setTip(el, text) { if (text) el.setAttribute("data-tip", text); else el.removeAttribute("data-tip"); }
// Hero 光晕跟随指针（只写两个 CSS 变量，不触发布局）。
document.addEventListener("pointermove", event => {
  const hero = event.target?.closest?.(".hero");
  if (!hero) return;
  const rect = hero.getBoundingClientRect?.();
  if (!rect) return;
  hero.style.setProperty("--mx", ((event.clientX - rect.left) / rect.width * 100).toFixed(1) + "%");
  hero.style.setProperty("--my", ((event.clientY - rect.top) / rect.height * 100).toFixed(1) + "%");
});
document.addEventListener("pointerover", event => showTip(event.target.closest?.("[data-tip]")));
document.addEventListener("pointerout", event => { if (event.target.closest?.("[data-tip]")) hideTip(); });
document.addEventListener("focusin", event => showTip(event.target.closest?.("[data-tip]")));
document.addEventListener("focusout", hideTip);
window.addEventListener("scroll", hideTip, true);

function disableControls() {
  for (const button of document.querySelectorAll("[data-command]")) button.disabled = true;
  $("stop").disabled = true;
  $("publishButton").disabled = true;
  $("updateTool").disabled = true;
}
function lostAuthorization(token) {
  if (token !== tokenInput.value.trim()) return;
  forgetToken(token);
  tokenInput.value = "";
  connected = false;
  $("authPanel").hidden = false; $("connect").textContent = "连接";
  $("dot").classList.remove("ok");
  $("connection").textContent = "未连接";
  $("globalRun").dataset.status="unknown"; $("globalRun").textContent="未连接";
  disableControls();
  stopStream();
  notice("访问令牌已失效或错误，请粘贴本次启动的新令牌。");
}
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
function renderTasks(data) {
  const tasks = data.tasks || [];
  const key = JSON.stringify([tasks, data.busy, data.github, listFilters.tasks]);
  if (lastTaskKey === key) return;
  lastTaskKey = key;
  const node = $("tasks");
  node.replaceChildren();
  renderFilterBar("taskFilters", "tasks", () => { lastTaskKey = ""; renderTasks(lastSnapshot ?? data); }, {
    all: tasks.length,
    active: tasks.filter(t => !taskDone(t)).length,
    done: tasks.filter(taskDone).length,
  });
  const visible = [...tasks].sort((a, b) => a.id - b.id).filter(task => passesFilter(listFilters.tasks, taskDone(task)));
  for (const task of visible) {
    const card = element("article", undefined, "task");
    const live=Boolean(data.runner) && (data.taskPhases ?? []).some(p=>p.taskId === (data.github?.tasks?.["TASK-"+String(task.id).padStart(3,"0")]?.issue ?? task.id) && p.status === "running");
    const merged=data.github?.tasks?.["TASK-"+String(task.id).padStart(3,"0")]?.pr?.state === "merged";
    card.dataset.status=live ? "running" : ["paused","blocked"].includes(task.status) ? "paused" : merged ? "completed" : "waiting";
    if (live) {const effect=element("div",undefined,"task-motion");effect.setAttribute("aria-hidden","true");card.append(effect);}
    card.append(element("div", "#" + task.id, "task-id"), element("div", task.title, "task-name"));
    const status = element("div", stateLabels[task.status] || task.status, "task-state");
    status.dataset.state = task.status;
    card.append(status, element("div", phaseLabels[task.phase] || task.phase || "尚未开始", "task-stage"),
      element("div", task.updatedAt ? new Date(task.updatedAt).toLocaleTimeString() : "—", "task-time"));
    const taskId = "TASK-" + String(task.id).padStart(3,"0");
    const remote = data.github?.status === "ok" ? data.github.tasks?.[taskId] : null;
    const details = [];
    if (remote?.pr) {
      const prState = {open:"待合并",merged:"已合并",closed:"已关闭"}[remote.pr.state] ?? "未知";
      const ciState = {pending:"运行中",success:"通过",failure:"失败",unknown:"未知"}[remote.pr.ci] ?? "未知";
      const box = element("div", undefined, "task-detail");
      if (typeof remote.pr.url === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(remote.pr.url)) {
        const link = element("a", remote.pr.title || `PR #${remote.pr.number}`, "pr-link");
        link.href = remote.pr.url; link.target = "_blank"; link.rel = "noopener noreferrer";
        box.append(link, document.createTextNode(` · ${prState} · CI ${ciState}`));
      } else box.append(document.createTextNode(`PR #${remote.pr.number} ${prState} · CI ${ciState}`));
      if (Array.isArray(remote.pr.activeChecks) && remote.pr.activeChecks.length) {
        for (const check of remote.pr.activeChecks) {
          const started = Date.parse(check.startedAt);
          const elapsed = Number.isFinite(started) ? ` · 已运行 ${Math.max(0, Math.floor((Date.now() - started) / 60000))} 分钟` : "";
          box.append(element("div", `CI 任务：${check.name}${elapsed}`, "task-detail"));
          if (check.stepStatus === "available") {
            const changed = check.stepObservedAt ? new Date(check.stepObservedAt).toLocaleString() : "未知";
            box.append(element("div", `当前步骤：${check.step?.name || "暂无运行中步骤"} · 步骤状态最近变化：${changed}（非日志时间）`, "task-detail"));
          } else box.append(element("div", "步骤状态不可用；实时日志请查看 GitHub", "task-detail"));
        }
      }
      if (remote.pr.state === "open") {
        const button = element("button", "合并并删除远程分支", "task-merge");
        button.disabled = Boolean(data.busy) || remote.pr.ci !== "success";
        button.addEventListener("click", () => void mergePr(remote.issue, remote.pr));
        box.append(button);
      }
      card.append(box);
    } else if (task.status === "done") details.push("本地执行结束；PR 状态待核实");
    if (task.status === "pending" && remote?.missing?.length) details.push("等待依赖合并：" + remote.missing.join("、"));
    if (details.length) card.append(element("div", details.join(" · "), "task-detail"));
    node.append(card);
  }
  if (!visible.length) node.append(element("div", tasks.length ? "该状态下暂无任务" : "暂无任务", "empty"));
}
function renderAgents() {
  const entries = [...agents.values()].sort((a,b) => a.taskId - b.taskId || a.role.localeCompare(b.role));
  const key = JSON.stringify([entries,[...actualModels.values()]]);
  if (key === lastAgentKey) return;
  lastAgentKey = key;
  const node = $("agentCards");
  node.replaceChildren();
  for (const activity of entries) {
    const item = element("article", undefined, "agent-card");
    const role = activity.role === "developer" ? "Developer" : "Reviewer";
    const state = activityLabels[activity.state] || "未知";
    item.append(element("strong", "#" + activity.taskId + " · " + role),
      element("span", state + (activity.tool ? " · " + activity.tool : ""), "agent-state"));
    const elapsed = element("span", "", "agent-elapsed");
    elapsed.dataset.startedAt = activity.startedAt;
    elapsed.dataset.activitySince = activity.activitySince;
    item.append(elapsed);
    const selected=actualModels.get(activity.taskId+":"+activity.role);
    if (selected) item.append(element("span", "模型："+(selected.provider && selected.model ? selected.provider+" / "+selected.model : "Pi 默认（具体模型未知）"),"agent-model"));
    node.append(item);
  }
  if (!entries.length) node.append(element("div", "暂无 Dashboard 启动的 Pi 会话活动", "empty"));
  updateElapsed();
}
function updateElapsed() {
  const fmt = timestamp => {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
    if (!Number.isFinite(seconds)) return "—";
    return Math.floor(seconds / 3600).toString().padStart(2,"0") + ":" +
      Math.floor(seconds % 3600 / 60).toString().padStart(2,"0") + ":" +
      (seconds % 60).toString().padStart(2,"0");
  };
  for (const label of document.querySelectorAll(".agent-elapsed"))
    label.textContent = "运行 " + fmt(label.dataset.startedAt) + " · 当前状态 " + fmt(label.dataset.activitySince);
}
function showMilestoneDetail(id, name, stage, limited, source) {
  $("milestoneTitle").textContent = id + " · " + name;
  const list=$("milestoneDetails"); list.replaceChildren();
  if (source === "local") list.append(element("p","GitHub 暂不可用，以下明细来自本地检查点与任务文件；合入状态可能滞后，请在 GitHub 复核。","hint"));
  if (limited) list.append(element("p","GitHub 查询达到上限，以下明细可能不完整。","hint"));
  if (!stage || !Array.isArray(stage.items)) list.append(element("p","暂无里程碑明细：GitHub 与本地检查点都没有可归类任务。","hint"));
  else if (!stage.items.length) list.append(element("p","该里程碑暂无已归类任务。","hint"));
  else {
    const rows = stage.items;
    renderFilterBar("milestoneFilters", "milestone", () => showMilestoneDetail(id, name, stage, limited, source), {
      all: rows.length,
      active: rows.filter(row => !row.merged).length,
      done: rows.filter(row => row.merged).length,
    });
    const shown = rows.filter(row => passesFilter(listFilters.milestone, Boolean(row.merged)));
    if (!shown.length) list.append(element("p", "该状态下暂无任务。", "hint"));
    for (const item of shown) {
    const row=element("div",undefined,"milestone-detail-row");
    const label=element(item.url ? "a" : "span", "#"+item.number+" "+item.title);
    if(item.url) { label.href=item.url; label.target="_blank"; label.rel="noopener noreferrer"; }
    // Six distinct states: colour alone is not enough, so every chip carries an icon.
    const state = item.merged ? { key:"merged", label:"已合入", icon:"✓" }
      : item.state === "CLOSED" ? { key:"unverified", label:"已关闭 · 合并待核实", icon:"⏳" }
      : item.labels.includes("agent:blocked") ? { key:"blocked", label:"已阻塞", icon:"⛔" }
      : item.labels.includes("agent:paused") ? { key:"paused", label:"已暂停", icon:"⏸" }
      : item.labels.includes("agent:in-progress") ? { key:"running", label:"进行中", icon:"▶" }
      : { key:"pending", label:"待处理", icon:"○" };
    const chip=element("span",state.icon+" "+state.label,"milestone-state");
    chip.dataset.state=state.key;
    if(item.localStatus) setTip(chip,"本地状态："+item.localStatus+"（未查询 GitHub）");
    row.append(label,chip); list.append(row);
    }
  }
  openDialog($("milestoneDialog"));
}
/** 里程碑区域的活跃/即将进行任务：定宽标签 + 悬浮全称。 */
function renderPhaseTasks(data) {
  const host = $("projectPhaseTasks");
  if (!host) return;
  host.replaceChildren();
  const tasks = data?.tasks ?? [];
  const active = tasks.filter(task => ["running", "paused", "blocked"].includes(task.status));
  const upcoming = tasks.filter(task => task.status === "pending");
  const list = active.length ? active : upcoming;
  host.append(element("span", active.length ? "活跃任务：" : "即将进行的任务：", "phase-tasks-label"));
  if (!list.length) { host.append(element("span", "无", "subtle")); return; }
  for (const task of list.slice(0, 8)) {
    const chip = element("span", task.title, "phase-task-chip");
    setTip(chip, "#" + task.id + " " + task.title);
    host.append(chip);
  }
  if (list.length > 8) host.append(element("span", "+" + (list.length - 8) + " 项", "subtle"));
}
function renderProjectPhase(github, data) {
  const names={M0:"工程治理",M1:"产品原型",M2:"多 Agent",M3:"开发工具",M4:"交付发布"};
  // GitHub 不可用时退回本地检查点推出的路线图，避免整块变成"待核实"。
  const roadmap=github?.status === "ok" ? github.tasks?.__roadmap : (data.roadmap ?? null);
  const key=JSON.stringify([roadmap,Boolean(data.runner),data.taskPhases]);
  if(key===lastRoadmapKey)return;
  lastRoadmapKey=key;
  const phases=new Set(data.runner ? (data.taskPhases ?? []).filter(p=>p.status === "running").map(p=>p.taskId) : []);
  const node=$("roadmapCards");node.replaceChildren();
  let running=0, paused=0, total=0, merged=0;
  for (const id of Object.keys(names)) {
    const stage=roadmap?.stages?.find(x=>x.id===id);
    const unknown=!roadmap || roadmap.limited || !stage || !stage.total;
    const active=!unknown && stage.issues.some(number=>phases.has(number));
    const state=unknown ? "unknown" : active ? "running" : stage.paused ? "paused" : stage.merged===stage.total && !stage.unknown ? "completed" : "waiting";
    if(active)running++;else if(state==="paused")paused++;
    if(!unknown){total+=stage.total;merged+=stage.merged;}
    const card=element("article",undefined,"milestone-card");card.dataset.status=state;
    card.setAttribute("role","button");card.setAttribute("tabindex","0");card.setAttribute("aria-label",id+" · "+names[id]+"，查看任务明细");
    const show=()=>showMilestoneDetail(id,names[id],stage,Boolean(roadmap?.limited),roadmap?.source);
    card.addEventListener("click",show);card.addEventListener("keydown",event=>{if(event.key==="Enter" || event.key===" "){event.preventDefault();show();}});
    const labels={unknown:"待核实",running:"进行中",paused:"暂停 / 阻塞",completed:"任务已合入 · 验收待确认",waiting:"等待推进"};
    const head=element("div",undefined,"milestone-heading");head.append(element("strong",id+" · "+names[id]),element("span",labels[state],"milestone-state"));card.append(head);
    const track=element("div",undefined,"milestone-track"), fill=element("span",undefined,"milestone-fill");
    track.setAttribute("role","progressbar");track.setAttribute("aria-label",id+" 已归类任务的合入进度");
    if(!unknown){track.setAttribute("aria-valuemin","0");track.setAttribute("aria-valuemax",String(stage.total));track.setAttribute("aria-valuenow",String(stage.merged));fill.style.width=`${stage.merged/stage.total*100}%`;}
    track.setAttribute("aria-valuetext",unknown ? "未知" : `${stage.merged} / ${stage.total} 项已合入${active ? "，执行进度未知" : ""}`);
    track.append(fill);if(active){const motion=element("span",undefined,"milestone-motion");motion.setAttribute("aria-hidden","true");track.append(motion);}card.append(track);
    card.append(element("small",unknown ? "暂无完整的归类与合并证据" : `${stage.merged} / ${stage.total} 项已合入`+(stage.unknown ? ` · ${stage.unknown} 项完成证据待核实` : ""),"hint"));
    node.append(card);
  }
  const local = roadmap?.source === "local";
  $("projectPhaseTitle").textContent=!roadmap ? "项目里程碑状态待核实" : running ? `${running} 个里程碑正在推进` : paused ? `${paused} 个里程碑有暂停或阻塞任务` : "已归类里程碑当前无活跃任务";
  $("projectPhaseCount").textContent=roadmap && !roadmap.limited ? `${merged} / ${total} 项已合入${local ? "（本地推定）" : ""}` : "—";
  renderPhaseTasks(data);
  $("projectPhaseDetail").textContent=!roadmap ? "GitHub 与本地检查点都没有可用的里程碑数据。" : roadmap.limited ? "GitHub 查询达到上限，进度待核实。" : local ? `GitHub 暂不可用，以上按本地检查点与任务文件推定；未归类 ${roadmap.unclassified} 项。合入与验收仍需在 GitHub 复核。` : `按任务元数据或 GitHub 里程碑自动归类；未归类 ${roadmap.unclassified} 项。运行状态基于控制台活动，数据可能有延迟。`;
}

function render(data) {
  if (typeof data.instanceId === "string") resetInstance(data.instanceId);
  connected = true;
  $("authPanel").hidden = true;
  $("dot").classList.add("ok");
  $("connection").textContent = "本机已连接";
  const tasks = data.tasks || [];
  for (const group of ["running", "pending", "done"]) $(group).textContent = tasks.filter(t => t.status === group).length;
  $("total").textContent = tasks.length;
  const blocked=tasks.filter(t=>t.status === "blocked" || t.status === "paused").length;
  $("globalRun").dataset.status=data.runner || data.externalLocks ? "running" : blocked ? "paused" : "idle";
  $("globalRun").textContent=data.runner ? "调度运行中" : blocked ? `${blocked} 项暂停 / 阻塞` : "调度空闲";
  $("badge").dataset.state = data.runner ? (data.runner.stopping ? "stopping" : "running") : data.externalLocks ? "external" : "idle";
  $("badge").textContent = data.runner ? (data.runner.stopping ? "停止中" : "运行中") : "空闲";
  $("runner").textContent = data.runner ? "正在执行 " + data.runner.command + " · 开始于 " + new Date(data.runner.startedAt).toLocaleTimeString()
    : data.externalLocks ? "检测到 " + data.externalLocks + " 个正在运行的工作树锁（此处不能停止）"
    : data.lastRun ? "上次执行 " + data.lastRun.command + " · 退出码 " + (data.lastRun.exitCode ?? "未知") : "未启动调度";
  $("updated").textContent = "更新于 " + new Date(data.generatedAt).toLocaleTimeString();
  for (const button of document.querySelectorAll("[data-command]")) button.disabled = data.busy;
  // Hot update stays available while a runner is busy: that is the point of it.
  $("updateTool").disabled = false;
  $("stop").disabled = !data.runner || data.runner.stopping;
  if (data.update) lastUpdate = data.update;
  $("updateStatus").textContent = updateText(lastUpdate, data.protocolVersion);
  applyUpdateBadge(lastUpdate);
  // 发布：preview 随时可发；release 需 dev 已合入 main（服务端也会再校验一次）。
  const publish = data.publish ?? null;
  $("publishButton").disabled = Boolean(data.busy);
  setTip($("publishButton"), publish?.error
    ? "发布状态不可用：" + publish.error
    : publish?.mergedIntoRelease ? publish.integrationBranch + " 已合入 " + publish.releaseBranch + "，release 将直接打 tag"
    : "release 将开 " + (publish?.integrationBranch ?? "dev") + "→" + (publish?.releaseBranch ?? "main") + " 的 PR，等必需检查通过后合并再打 tag");
  // 人工通道：release 走 PR，不依赖本地检出状态，因此只有状态不可用或 Runner 忙时才禁用。
  const releaseBlocked = !publish || publish.error ? "发布状态不可用" : null;
  $("publishRelease").disabled = Boolean(releaseBlocked) || Boolean(data.busy);
  setTip($("publishRelease"), releaseBlocked ?? (publish.mergedIntoRelease
    ? publish.integrationBranch + " 已合入 " + publish.releaseBranch + "，将直接在 " + publish.releaseBranch + " 打 tag"
    : "将创建 " + publish.integrationBranch + "→" + publish.releaseBranch + " 的 PR，等必需检查通过后合并，再打 tag"));
  $("publishHint").textContent = publish?.error
    ? "发布状态不可用：" + publish.error
    : publish?.mergedIntoRelease
      ? (publish.integrationBranch + " 已合入 " + publish.releaseBranch + "，release 将直接打 tag")
      : "release 将开 " + (publish?.integrationBranch ?? "dev") + "→" + (publish?.releaseBranch ?? "main") + " 的 PR，等必需检查通过后合并，再打 tag";
  $("githubStatus").textContent = data.github?.status === "ok" ? "GitHub PR / CI 状态已更新 · " + new Date(data.github.updatedAt).toLocaleTimeString()
    : data.github?.status === "unavailable" ? "GitHub 状态不可用：请检查 gh 登录和网络；任务与 CI 状态未知" : "GitHub 状态加载中";
  // 锁只在确有活跃锁时作为诊断附加显示，不再用它改写主状态。
$("developmentLane").textContent = (data.runner ? "控制台调度运行中" : "控制台当前空闲")
  + (data.externalLocks > 0 ? `（另有 ${data.externalLocks} 个任务锁）` : "");
  const reportLabel = lane => !lane ? "状态加载中" : lane.status === "unavailable" ? "本地报告状态不可用" : lane.status === "empty" ? "暂无本地建议报告" : `本地报告 ${lane.count} 份 · 最近 ${new Date(lane.lastAt).toLocaleString()}`;
  advisoryState = data.advisory ?? null;
  for (const lane of ["product","quality"]) {
    const prefix=lane === "product" ? "product" : "quality";
    const current=advisoryState?.active?.lane === lane;
    const last=advisoryState?.last?.lane === lane ? advisoryState.last : null;
    $(prefix+"Lane").textContent=current ? "正在分析" : reportLabel(data.lanes?.[lane]);
    $("run"+prefix[0].toUpperCase()+prefix.slice(1)).disabled=Boolean(advisoryState?.active);
    $(prefix+"RunState").textContent=current ? "正在分析"+(advisoryState.active.model ? " · "+(advisoryState.active.model.provider ? advisoryState.active.model.provider+" / "+advisoryState.active.model.model : "Pi 默认（具体模型未知）") : "")+"；可关闭弹窗，任务会继续。" : last?.status === "failed" ? "上次分析失败（"+last.reason+"）；未自动重试。" : last?.status === "completed" ? "上次分析完成，结果仍需人工核实。" : "手动运行一次只读分析，结果需人工核实。";
    const reportKey=last?.status === "completed" ? last.finishedAt : "";
    if (reportKey && $(prefix+"Dialog").open && loadedReportKeys[lane] !== reportKey) {loadedReportKeys[lane]=reportKey;void loadAdvisory(lane);}
  }
  const lessons=data.lanes?.lessons;
  $("lessonsStatus").textContent=lessons?.status === "available" ? `已记录 ${lessons.count} 条教训，${lessons.eligible} 条达到提出申请的条件。每条须有至少 3 个不同日期的证据；维护者核实、批准并通过单独治理 PR，不自动修改规则。` : "复盘规则：同一规则须有至少 3 个不同日期的证据，才可提出人工晋升申请；教训记录状态待核实。";
  renderProjectPhase(data.github,data);
  // 分类按钮同时作用于草稿与已创建需求，否则用户点"已完成"看不到任何变化。
  lastStatus = data;
  renderQueue();
  renderDrafts(data.drafts, data.intake);
  updateRunTimers();
  renderTasks(data);
  if (Array.isArray(data.taskModels)) actualModels = new Map(data.taskModels.map(m=>[m.taskId+":"+m.role,m]));
  if (data.modelInfo?.status === "ok") {modelSettings=data.modelInfo.settings;renderModelSummary(data.modelInfo);}
  else $("modelSummary").textContent="模型配置不可用，请检查本地配置。";
  if (Array.isArray(data.agents)) {
    agents = new Map(data.agents.map(a => [a.taskId + ":" + a.role, a]));
    renderAgents();
  }
  rebuildLogs(data.log);
}
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
      $("dot").classList.remove("ok");
      $("connection").textContent = "连接中断";
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
function legacyCopy(text) {
  if (!document.body) return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  document.body.appendChild(area);
  try {
    area.focus?.();
    area.select?.();
    area.setSelectionRange?.(0, text.length);
    return Boolean(document.execCommand?.("copy"));
  } catch { return false; }
  finally { document.body.removeChild(area); }
}
async function copyText(text) {
  if (!text) { notice("没有可复制的内容。"); return; }
  if (window.isSecureContext !== false && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); notice("已复制到剪贴板。"); return; }
    catch { /* Fall through to the legacy path. */ }
  }
  if (legacyCopy(text)) { notice("已复制到剪贴板。"); return; }
  notice("此页面不是安全上下文，浏览器禁止自动复制；请长按选择文本后手动复制。");
}
function copyButton(text, label) {
  const button=element("button","⧉","icon-button"); button.type="button";
  button.setAttribute("aria-label",label);setTip(button,label);
  button.addEventListener("click",()=>void copyText(text));return button;
}
function reportParts(report) {
  const parts=[{title:"摘要",text:report.summary}];
  for(const f of report.findings) parts.push({title:f.title,text:f.recommendation+"\n置信度："+f.confidence+"\n证据："+(f.evidence.join("；") || "未提供")});
  if(report.unknowns.length) parts.push({title:"待核实",text:report.unknowns.join("\n")});
  return parts;
}
async function loadAdvisory(lane, selected=null) {
  const node=$(lane+"Report"), list=$(lane+"Reports");
  node.replaceChildren(element("p","正在读取本地报告…","hint"));
  try {
    const {reports}=await api("/api/advisory-reports?lane="+lane);
    if (!Array.isArray(reports)) throw new Error("报告列表不可用");
    list.replaceChildren();
    for(const item of reports) {const option=element("option",new Date(item.modifiedAt).toLocaleString());option.value=item.name;list.append(option);}
    const name=reports.some(x=>x.name===selected) ? selected : reports[0]?.name;
    $(lane+"Clear").disabled=!reports.length;
    $(lane+"Delete").disabled=$(lane+"Copy").disabled=!name;
    if (!name) {currentReports[lane]=null;node.replaceChildren(element("p","暂无报告，请手动开始分析。","hint"));return;}
    list.value=name;
    const {report}=await api("/api/advisory-reports?lane="+lane+"&name="+encodeURIComponent(name));
    currentReports[lane]=report;
    node.replaceChildren();node.append(element("p","未经核实的模型建议"+(report.createdAt ? " · "+new Date(report.createdAt).toLocaleString() : ""),"notice"));
    for(const part of reportParts(report)) {const block=element("div",undefined,"assessment-block");const head=element("div",undefined,"report-heading");head.append(element("strong",part.title),copyButton(part.title+"\n"+part.text,"复制"+part.title));block.append(head,element("p",part.text));node.append(block);}
  } catch(error) {currentReports[lane]=null;node.replaceChildren(element("p","报告读取失败："+error.message,"error-text"));}
}
async function deleteAdvisory(lane, all) {
  const name=all ? null : $(lane+"Reports").value;
  if(!all && !name) return;
  if(!await askConfirm(all ? "确认清空此轨道的本地报告？" : "确认删除当前本地报告？")) return;
  try {await api("/api/advisory-delete",{method:"POST",body:{lane,name}});await loadAdvisory(lane);await refresh();}
  catch(error) {notice("删除报告失败："+error.message);}
}
async function openAdvisory(lane) {
  if (!connected) return notice("先连接本地控制台。");
  const prefix=lane === "product" ? "product" : "quality";
  openDialog($(prefix+"Dialog"));await loadAdvisory(lane);
}
async function startAdvisory(lane) {
  if (!connected) return notice("先连接本地控制台。");
  if (!await askConfirm("即将启动一次只读模型分析，可能产生费用；失败不会自动重试。继续？")) return;
  try {await api("/api/advisory-run",{method:"POST",body:{lane}});await refresh();}
  catch(error){$(lane+"RunState").textContent="分析启动失败："+error.message; }
}
function elapsedText(startedAt) {
  const value=Date.parse(startedAt);if(!Number.isFinite(value)) return "耗时未知";
  const seconds=Math.max(0,Math.floor((Date.now()-value)/1000));
  return "已运行 "+Math.floor(seconds/60)+"分 "+String(seconds%60).padStart(2,"0")+"秒";
}
function updateRunTimers() {
  const active=currentIntake?.status === "assessing";
  const intake=$("intakeRunState");intake.dataset.running=String(active);
  intake.textContent=active ? "正在评估 · "+elapsedText(currentIntake.startedAt) : "";
  for(const lane of ["product","quality"]) {
    const job=advisoryState?.active?.lane===lane ? advisoryState.active : null;
    const state=$(lane+"RunState");state.dataset.running=String(Boolean(job));
    if(job) state.textContent="正在分析 · "+elapsedText(job.startedAt)+(job.model?.provider ? " · "+job.model.provider+" / "+job.model.model : "");
  }
}
let themeSwitchTimer = null;
/**
 * 主题切换：优先用 View Transitions 做从主题按钮扩散的圆形转场（平滑且不闪烁），
 * 不支持时退回到全站颜色过渡。首次应用主题不播动画。
 */
function setTheme(theme) {
  const root = document.documentElement;
  const changed = Boolean(root.dataset.theme) && root.dataset.theme !== theme;
  const apply = () => { root.dataset.theme = theme; };
  if (!changed) { apply(); themeLabelAndSave(theme); return; }
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  // View Transitions：从主题按钮位置圆形扩散。转场会对整页做快照，top-layer 弹窗
  // 不在快照内会出现遮挡，所以切换前先立即关闭所有打开的弹窗（不播退场动画）。
  if (!reduce && typeof document.startViewTransition === "function") {
    for (const dialog of document.querySelectorAll("dialog[open]")) {
      try { dialog.getAnimations?.().forEach(item => item.cancel()); } catch {}
      delete dialog.dataset.closing;
      dialog.classList.remove("closing");
      try { dialog.close(); } catch {}
    }
    const button = $("themeToggle");
    const rect = button?.getBoundingClientRect?.();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : 0;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    let settled = false;
    const cleanup = () => { if (settled) return; settled = true; };
    const transition = document.startViewTransition(apply);
    const guard = setTimeout(cleanup, 900);
    transition.ready.then(() => {
      clearTimeout(guard);
      return document.documentElement.animate(
        { clipPath: ["circle(0px at " + x + "px " + y + "px)", "circle(" + radius + "px at " + x + "px " + y + "px)"] },
        { duration: 560, easing: "cubic-bezier(.22,.61,.36,1)", pseudoElement: "::view-transition-new(root)" },
      ).finished;
    }).then(() => { cleanup(); }, () => { cleanup(); }).catch(() => { cleanup(); });
    themeLabelAndSave(theme);
    return;
  }
  // 不支持 View Transitions（旧内核/减少动效）：全站颜色柔和过渡。
  root.classList?.add("theme-switching");
  clearTimeout(themeSwitchTimer);
  themeSwitchTimer = setTimeout(() => root.classList?.remove("theme-switching"), 640);
  apply();
  themeLabelAndSave(theme);
}
function themeLabelAndSave(theme) {
  const nextTheme = theme === "dark" ? "light" : "dark";
  const label = nextTheme === "light" ? "切换到浅色主题" : "切换到深色主题";
  $("themeToggle").dataset.nextTheme = nextTheme;
  $("themeToggle").setAttribute("aria-label", label);
  setTip($("themeToggle"), label);
  save(preferenceStorage, THEME_KEY, theme);
}
const NO_UNKNOWNS=/^(?:无|暂无|没有|无需确认|无待确认项|none|null|n\/a)[。.！!]?$/i;
function draftQuestions(a) {
  const raw=String(a?.unknowns || "").split(/\n+/).map(x=>x.replace(/^\s*(?:[-*•]|\d+[.、])\s*/, "").trim()).filter(x=>x && !NO_UNKNOWNS.test(x));
  const supplied=Array.isArray(a?.questions) ? a.questions : [];
  if(supplied.length===raw.length && raw.length) return supplied.map((q,i)=>({...q,text:raw[i]===q.text?q.text:raw[i]+" — "+q.text}));
  return [...raw.map(text=>({text,options:[]})),...supplied];
}
/** One draft row; shared by the active list and the collapsed completed section. */
function draftRow(d) {
  const row=element("div",undefined,"queue-item"), label=element("label"), box=element("input");box.type="checkbox";box.checked=selectedDrafts.has(d.id);box.disabled=d.status!=="review" || !Array.isArray(d.answers) || draftState.busy;box.addEventListener("change",()=>{if(box.checked)selectedDrafts.add(d.id);else selectedDrafts.delete(d.id);});label.append(box,document.createTextNode(" "+(d.assessment?.title || d.requirement.slice(0,60))+" · "+({draft:"草稿",review:d.answers?"可提交":"待确认",assessing:"评估中",submitting:"提交中",submitted:"已提交",unknown:"结果待核实"}[d.status]||d.status)));row.append(label);
  for(const [text,action,disabled] of [["编辑",()=>openDraft(d),["unknown","submitted","submitting"].includes(d.status)],["上移",()=>draftAction("move",{id:d.id,direction:-1}),false],["下移",()=>draftAction("move",{id:d.id,direction:1}),false],["删除",async()=>{if(await askConfirm("删除这个草稿？"))void draftAction("remove",{id:d.id});},d.status==="unknown"]]){const b=element("button",text);b.disabled=disabled||draftState.busy;b.addEventListener("click",action);row.append(b);}
  if(d.status==="unknown"){const b=element("button","核实结果");b.disabled=draftState.busy;b.addEventListener("click",async()=>{const created=await askConfirm("请先在 GitHub 检查。确定已创建选择‘确定’；确认未创建选择‘取消’。");if(created){const url=await askText("输入已创建的 GitHub Issue 链接：");if(!url)return;await draftAction("resolve",{id:d.id,created:true,url});}else if(await askConfirm("确认 GitHub 中没有创建该需求，允许重新提交？"))await draftAction("resolve",{id:d.id,created:false,url:null});});row.append(b);}
  if(d.status==="submitted" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(d.url || "")){const a=element("a","查看 Issue");a.href=d.url;a.target="_blank";a.rel="noopener noreferrer";row.append(a);}
  return row;
}
/** 已创建需求队列；分类（全部/进行中/已完成）与草稿列表共用同一个筛选状态。 */
function renderQueue() {
  const data = lastStatus;
  if (!data) return;
  const queueItems = data.github?.status === "ok" ? data.github.tasks?.__queue || [] : [];
  queueSnapshot = queueItems;
  const queueVisible = queueItems.filter(item => passesFilter(listFilters.drafts, item.state === "CLOSED"));
  const queueKey=JSON.stringify([data.github?.status,queueItems,data.tasks,data.taskPhases,listFilters.drafts]);
  const queue=$("queueList");
  if (queueKey === lastQueueKey) return;
  lastQueueKey=queueKey; queue.replaceChildren();
  if (data.github?.status !== "ok") { queue.append(element("div","GitHub 需求列表暂不可用，请检查连接后重试。","empty")); return; }
  if (!queueItems.length) { queue.append(element("div","没有已创建的需求。","empty")); return; }
  if (!queueVisible.length) { queue.append(element("div","当前分类下没有已创建的需求。","empty")); return; }
  for (const item of queueVisible) {
    const row=element("div",undefined,"queue-item");
    const title=element(item.url ? "a" : "span",`#${item.number} ${item.title}`,"pr-link");
    if (item.url && /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(item.url)) {title.href=item.url;title.target="_blank";title.rel="noopener noreferrer";}
    const checkpoint=item.checkpoint;
    const live=(data.taskPhases || []).find(t=>t.taskId===item.number);
    const state=item.state === "CLOSED" ? (item.merged ? "已关闭 · PR 已合并" : "已关闭 · 合并状态待核实") : live?.status === "running" ? "执行中 · "+live.phase : checkpoint?.status === "paused" ? "已暂停 · "+(checkpoint.phase ?? "") : checkpoint?.status === "blocked" ? "已阻塞 · "+(checkpoint.phase ?? "") : "等待执行";
    row.append(title,element("span",state,"queue-state"));queue.append(row);
  }
}
function renderDrafts(data, legacy = null) {
  draftState=data ?? {items:[],busy:false};
  const items=draftState.items || []; const list=$("draftList");
  // 没有草稿时这个按钮没有意义，隐藏它（有草稿才出现）。
  $("batchDrafts").hidden = items.length === 0;
  const key=JSON.stringify(draftState)+JSON.stringify([...selectedDrafts])+JSON.stringify(legacy)+listFilters.drafts;
  if(key!==lastDraftKey){lastDraftKey=key;list.replaceChildren();
    if(legacy?.status === "unknown"){const row=element("div",undefined,"queue-item");row.append(element("span","旧版提交结果待核实：请先检查 GitHub。"));const b=element("button","已核实，解除旧锁定");b.addEventListener("click",async()=>{if(await askConfirm("确认已检查 GitHub 中是否创建该需求？")){try{await api("/api/intake-clear",{method:"POST",body:{id:legacy.id}});await refresh();}catch(e){notice("解除锁定失败："+e.message);}}});row.append(b);list.append(row);}
    const activeItems=items.filter(x=>!draftDone(x));
    const completed=items.filter(draftDone);
    const allCount = items.length + queueSnapshot.length;
    const doneCount = completed.length + queueSnapshot.filter(x => x.state === "CLOSED").length;
    renderFilterBar("draftFilters","drafts",()=>{lastDraftKey="";lastQueueKey="";renderQueue();renderDrafts(draftState,legacy);},{all:allCount,active:allCount-doneCount,done:doneCount});
    if(listFilters.drafts!=="done") for(const d of activeItems) list.append(draftRow(d));
    // Finished requirements live in a collapsed section so the active queue stays short.
    if(completed.length && listFilters.drafts!=="active"){const box=element("details",undefined,"queue-completed");box.append(element("summary","已完成需求 · "+completed.length+" 项"));const inner=element("div",undefined,"queue-list");for(const d of completed) inner.append(draftRow(d));box.append(inner);list.append(box);}
  }
  const current=items.find(x=>x.id===editingDraft) || null;
  currentIntake=current || items.find(x=>x.status==="assessing") || legacy;updateRunTimers();
  $("intakeSummary").textContent=items.some(x=>x.status==="assessing") ? "Agent 正在评估 · "+elapsedText(items.find(x=>x.status==="assessing").startedAt) : items.length?`本地草稿 ${items.length} 项`:"暂无草稿";
  if(!$("intakeDialog").open) return;
  const resultKey=JSON.stringify(current);if(resultKey===lastIntakeKey)return;lastIntakeKey=resultKey;
  const node=$("intakeResult");node.replaceChildren();
  $("assessIntake").disabled=draftState.busy;$("saveDraft").disabled=draftState.busy;
  // While the agent evaluates, the requirement box is irrelevant: hide it instead of
  // showing a read-only field that looks editable.
  const assessing=Boolean(current && current.status==="assessing")||draftState.busy;
  $("requirementField").hidden=assessing;
  $("assessingHint").hidden=!assessing||!current;
  $("requirement").readOnly=draftState.busy;
  $("saveAnswers").disabled=current?.status!=="review"||draftState.busy;
  $("submitIntake").disabled=current?.status!=="review"||draftState.busy;
  $("reassessIntake").disabled=current?.status!=="review"||draftState.busy||!(current?.answers?.length);
  $("clearIntake").hidden=true;
  if(!current)return;
  if(current.error)node.append(element("p",current.error,"error-text"));
  if(!current.assessment)return;
  let unknownsDetails=null;
  for(const [key,label] of [["title","建议标题"],["feasibility","可行性"],["plan","实施安排"],["dependencies","前置依赖"],["acceptance","验收标准"],["unknowns","未知与待确认"]]){
    const details=element("details",undefined,"assessment-block");
    const summary=element("summary",label+(key==="feasibility" ? " · "+({feasible:"🟢 可行",conditional:"🟡 有条件可行",infeasible:"🔴 不可行",unknown:"⚪ 待确认"}[current.assessment.feasibilityStatus] || "⚪ 待确认") : ""));
    if(key==="dependencies"){
      // Show recognised task ids first, then each prerequisite as its own line.
      const text=String(current.assessment.dependencies||"");
      const ids=[...new Set(text.match(/TASK-\d{3,}/g)||[])];
      const wrap=element("div",undefined,"dependency-block");
      if(ids.length) wrap.append(element("p","识别到前置任务："+ids.join("、"),"dependency-ids"));
      const lines=text.split(/\n+/).map(x=>x.replace(/^\s*(?:[-*•]|\d+[.、])\s*/,"").trim()).filter(Boolean);
      const list=element("ul",undefined,"dependency-list");
      for(const line of (lines.length?lines:["未提及明确前置依赖，提交前请人工确认。"])) list.append(element("li",line));
      wrap.append(list);details.append(summary,wrap);details.open=true;node.append(details);continue;
    }
    details.append(summary,element("p",current.assessment[key]));
    if(key==="unknowns"){unknownsDetails=details;details.open=true;}
    node.append(details);
  }
  if(current.answersReset) node.append(element("p","评估已更新，待确认项发生变化，请重新确认后再提交。","error-text"));
  const qs=draftQuestions(current.assessment);qs.forEach((q,i)=>{const field=element("fieldset",undefined,"assessment-block"),legend=element("legend",q.text);field.append(legend);for(const option of q.options){const label=element("label"),check=element("input");check.type="checkbox";check.value=option;check.checked=current.answers?.[i]?.selected?.includes(option)||false;label.append(check,document.createTextNode(" "+option));field.append(label);}const custom=element("textarea");custom.rows=2;custom.maxLength=400;custom.placeholder="补充或自填";custom.value=current.answers?.[i]?.custom||"";field.append(custom);
    // Questions live inside the unknowns block so collapsing it hides them too.
    (unknownsDetails||node).append(field);field.addEventListener("input",updateAnswerButtons);field.addEventListener("change",updateAnswerButtons);});
  updateAnswerButtons();
  $("queueReady").checked=current.ready===true;$("intakeMilestone").value=current.milestone||"";
}
function openDraft(d){editingDraft=d?.id||null;$("requirement").value=d?.requirement||"";lastIntakeKey="";openDialog($("intakeDialog"));renderDrafts(draftState);}
async function draftAction(action,body){try{const result=await api("/api/drafts-"+action,{method:"POST",body});renderDrafts(result);return result;}catch(e){notice("操作失败："+e.message);return null;}}
async function saveDraft(){const result=await draftAction("save",{id:editingDraft,requirement:$("requirement").value});if(result && !editingDraft)editingDraft=result.items.at(-1).id;lastIntakeKey="";if(result)renderDrafts(result);return result;}
function updateAnswerButtons(){const complete=collectAnswers().every(a=>a.selected.length || a.custom.trim());$("saveAnswers").disabled=!complete || draftState.busy;$("submitIntake").disabled=!complete || draftState.busy;$("reassessIntake").disabled=!complete || draftState.busy || currentIntake?.status!=="review";}
function collectAnswers(){return [...$("intakeResult").querySelectorAll("fieldset")].map(field=>({selected:[...field.querySelectorAll('input:checked')].map(x=>x.value),custom:field.querySelector("textarea").value}));}
async function saveDraftAnswers(){const result=await draftAction("answer",{id:editingDraft,answers:collectAnswers(),ready:$("queueReady").checked,milestone:$("intakeMilestone").value||null});return result;}
async function mergePr(issue, pr) {
  if (!connected || !Number.isSafeInteger(issue) || !Number.isSafeInteger(pr.number)) return;
  if (!await askConfirm(`合并 PR #${pr.number}「${pr.title}」并删除远程分支？将重新检查 PR、CI 和分支头。`)) return;
  try {
    const result = await api("/api/merge", {method:"POST", body:{issue,pr:pr.number}});
    notice(result.branchDeleted ? `PR #${pr.number} 已合并，远程分支已删除。` : `PR #${pr.number} 已合并，但远程分支删除失败：${result.branch || "请检查"}`);
    await refresh();
  } catch (error) { notice("合并失败：" + error.message); }
}
async function execute(command) {
  if (!connected) return notice("先连接本地控制台。");
  if (command === "start" && !await askConfirm("启动会先恢复可恢复的暂停/阻塞任务，没有可恢复任务时执行下一批；两者都可能调用模型并产生费用。继续？")) return;
  if (command === "loop" && !await askConfirm("启动循环会连续执行多轮 Agent 任务并产生模型费用。确认？")) return;
  if (command === "watch" && !await askConfirm("启动监控可重复执行 Agent 任务并产生模型费用。确认启用受策略限制的监控？")) return;
  try {
    const result = await api("/api/run", { method:"POST", body:{ command } });
    notice("已接受：" + result.command + "。停止仅作用于此控制台启动的任务。");
    await refresh();
  } catch (error) { notice("操作失败：" + error.message); }
}

const pageNames=["Overview","Execution","Monitor","Requirements","Lanes","Models"];
function showPage(name) {
  if (!pageNames.includes(name)) name="Overview";
  for (const page of pageNames) {
    $("page"+page).hidden=page!==name;
    $("nav"+page).setAttribute("aria-current",page===name ? "page" : "false");
  }
  save(preferenceStorage,PAGE_KEY,name);
}
/** Badge lives in the button's hover text instead of taking space in the row. */
let lastUpdate = null;
function updateBadge(info) {
  if (!info) return "更新状态未检查：点击检查";
  if (info.available) return "（可更新）点击更新到 " + (info.comparison ?? "main → origin/main");
  if (info.dirty) return "（无需更新）工具仓库有本地改动，无法自动更新";
  return "（无需更新）已是最新 · " + (info.comparison ?? "main → origin/main");
}
function applyUpdateBadge(info) {
  setTip($("updateTool"), updateBadge(info));
  $("updateTool").setAttribute("aria-label", "从 GitHub 更新：" + updateBadge(info));
}
function updateText(info, protocolVersion) {
  const protocol = protocolVersion ? " · 协议 v" + protocolVersion : "";
  const basis = info?.comparison ? " · " + info.comparison : "";
  if (!info) return "尚未检查" + protocol;
  const version = info.toolVersion ? " · 工具 " + info.toolVersion : "";
  if (info.status === "updated") return "已更新到 " + String(info.current ?? "").slice(0, 8) + " · 控制台正在重启" + version;
  if (info.status === "rolled-back") return "更新失败，已回滚到 " + String(info.current ?? "").slice(0, 8) + (info.error ? " · " + info.error : "");
  if (info.dirty) return "工具仓库有本地改动，无法自动更新" + protocol + version;
  if (info.available) return "有更新可用 · behind " + info.behind + basis + protocol + version;
  if (info.status === "ok") return "已是最新" + basis + protocol + version;
  if (info.status === "up-to-date") return "已是最新" + version;
  return (info.status || "未知") + (info.error ? " · " + info.error : "") + protocol;
}
/** 按钮内嵌 loading：文本不变，叠加转圈图标并禁用，避免布局跳动。 */
function buttonBusy(el, busy) {
  el.disabled = busy;
  if (busy && !el.querySelector(".btn-spin")) {
    const spin = element("span", undefined, "btn-spin");
    spin.setAttribute("aria-hidden", "true");
    el.prepend(spin);
  } else if (!busy) el.querySelector(".btn-spin")?.remove();
}
/** No update: the click checks. Update available: the click applies it. */
async function updateFromGithub() {
  if (!connected) return notice("先连接本地控制台。");
  const button = $("updateTool");
  if (button.disabled) return;
  buttonBusy(button, true);
  $("updateStatus").textContent = "正在检查更新…";
  try {
    if (lastUpdate?.available) return await applyToolUpdate(lastUpdate);
    const check = await api("/api/update", { method: "POST", body: { action: "check" } });
    lastUpdate = check;
    $("updateStatus").textContent = updateText(check, check.protocolVersion);
    applyUpdateBadge(check);
    if (!check.available) { notice(check.dirty ? "工具仓库有本地改动，无法自动更新" : "已是最新版本"); return; }
    notice("发现更新（" + (check.comparison ?? "main → origin/main") + "，behind " + check.behind + "），再次点击按钮即更新。");
  } catch (error) {
    notice("检查更新失败：" + error.message);
    $("updateStatus").textContent = "检查更新失败：" + error.message;
  } finally {
    buttonBusy(button, false);
  }
}
async function applyToolUpdate(check) {
  if (!await askConfirm("更新到 " + (check.behind ?? 1) + " 个新提交并重启控制台？正在运行的任务不会被中断（新控制台会自动接管），冒烟失败会自动回滚。")) return;
  const button = $("updateTool");
  buttonBusy(button, true);
  $("updateStatus").textContent = "正在下载并应用更新…";
  $("restartOverlay").hidden = false;
  try {
    const result = await api("/api/update", { method: "POST", body: { action: "apply" } });
    if (result.status === "updated" || result.status === "up-to-date") lastUpdate = { ...check, available: false, behind: 0 };
    $("updateStatus").textContent = updateText(result, result.protocolVersion);
    applyUpdateBadge(lastUpdate);
    notice(result.restarting ? "已更新，控制台正在重启；页面会自动重连并接管运行中的任务。" : "更新结果：" + result.status);
    if (!result.restarting) $("restartOverlay").hidden = true;
  } catch (error) {
    $("restartOverlay").hidden = true;
    $("updateStatus").textContent = "更新失败：" + error.message;
    notice("更新失败：" + error.message);
  } finally {
    buttonBusy(button, false);
  }
}
/** 服务器换新（instanceId 变化）即接管成功：隐藏覆盖层。 */
function watchRestartTakeover() {
  const original = resetInstance;
  // resetInstance 在新 instanceId 时重建全部状态；接管成功后关掉覆盖层。
  return function patchedReset(next) {
    const changed = instanceId !== next;
    original(next);
    if (changed) $("restartOverlay").hidden = true;
  };
}
$("updateTool").addEventListener("click", () => void updateFromGithub());
for (const page of pageNames) $("nav"+page).addEventListener("click",()=>showPage(page));
function renderModelSummary(info) {
  const container=$("modelSummary"); container.replaceChildren();
  const names={developer:"Developer",reviewer:"Reviewer",product:"Product",quality:"Quality",intake:"需求评估"};
  for (const [role,label] of Object.entries(names)) {
    const chosen=info.selected?.[role], pool=info.settings.roles[role] ?? info.settings.global;
    const text=info.envOverrides?.[role] ? "环境变量覆盖 · "+(chosen?.provider ?? "默认")+" / "+(chosen?.model ?? "未知") : pool?.length > 1 ? `轮换 ${pool.length} 个 · 示例 ${chosen?.provider ?? "默认"} / ${chosen?.model ?? "未知"}` : chosen?.provider ? chosen.provider+" / "+chosen.model : "Pi 默认（具体模型未知）";
    container.append(element("div",label+"："+text,"model-summary-row"));
  }
}
function modelKey(item) {return item.provider+"\0"+item.model;}
function getScopePool() {
  const scope=$("modelScope").value;
  return scope === "global" ? modelDraft.global : modelDraft.roles[scope];
}
function renderModelChoices() {
  if (!modelDraft) return;
  const scope=$("modelScope").value, inherit=scope!=="global" && modelDraft.roles[scope]===null;
  $("modelInherit").disabled=scope==="global";$("modelInherit").checked=inherit;
  const selected=getScopePool() || [], query=$("modelSearch").value.trim().toLowerCase();
  const favorites=new Set(modelDraft.favorites.map(modelKey));
  const items=new Map(modelCatalog.map(x=>[modelKey(x),{...x,available:true}]));
  for (const x of [...modelDraft.global,...Object.values(modelDraft.roles).flatMap(x=>x??[]),...modelDraft.favorites]) if (!items.has(modelKey(x))) items.set(modelKey(x),{...x,available:false});
  const groups=new Map();
  for (const item of items.values()) {
    if (query && !(item.provider+" "+item.model).toLowerCase().includes(query)) continue;
    const groupName = favorites.has(modelKey(item)) ? "★ 已收藏" : item.provider;
    if (!groups.has(groupName)) groups.set(groupName,[]);
    groups.get(groupName).push(item);
  }
  const container=$("modelGroups");container.replaceChildren();
  let remaining=300;
  for (const [provider,models] of [...groups].sort(([a,aa],[b,bb])=>Number(bb.some(x=>favorites.has(modelKey(x))))-Number(aa.some(x=>favorites.has(modelKey(x)))) || a.localeCompare(b))) {
    if (!remaining) break;
    const group=element("details",undefined,"model-group");group.open=Boolean(query) || provider==="★ 已收藏";
    group.append(element("summary",provider+" · "+models.length));
    models.sort((a,b)=>Number(favorites.has(modelKey(b)))-Number(favorites.has(modelKey(a))) || a.model.localeCompare(b.model));
    const visible=models.slice(0,remaining); remaining-=visible.length;
    for (const item of visible) {
      const row=element("div",undefined,"model-option"), label=element("label"), input=element("input");
      input.type="checkbox";input.checked=selected.some(x=>modelKey(x)===modelKey(item));input.disabled=inherit || (!item.available && !input.checked);
      input.addEventListener("change",()=>{
        const current=getScopePool() || [];const pair={provider:item.provider,model:item.model};
        const next=input.checked ? [...current,pair] : current.filter(x=>modelKey(x)!==modelKey(item));
        if (next.length>20) {input.checked=false;$("modelMessage").textContent="每个模型池最多选择 20 个模型。";return;}
        if(scope==="global")modelDraft.global=next;else modelDraft.roles[scope]=next;
      });
      label.append(input,document.createTextNode(" "+(provider==="★ 已收藏" ? item.provider+" / " : "")+item.model+(item.available ? "" : "（未在本次列表中）")));
      const star=element("button",favorites.has(modelKey(item)) ? "★" : "☆","model-star");star.setAttribute("aria-label",favorites.has(modelKey(item)) ? "取消置顶 "+item.model : "置顶 "+item.model);
      star.addEventListener("click",()=>{const pair={provider:item.provider,model:item.model};modelDraft.favorites=favorites.has(modelKey(item)) ? modelDraft.favorites.filter(x=>modelKey(x)!==modelKey(item)) : [...modelDraft.favorites,pair];renderModelChoices();});
      row.append(label,star);group.append(row);
    }
    container.append(group);
  }
  if (!groups.size) container.append(element("p","没有匹配模型","hint"));
  else if ([...groups.values()].reduce((total,rows)=>total+rows.length,0)>300) container.append(element("p","仅展示前 300 个模型，请继续搜索以缩小范围。","hint"));
}
async function refreshModelCatalog() {
  $("modelMessage").textContent="正在读取本机 Pi 模型列表…";
  $("reloadModels").disabled=true;
  try {const result=await api("/api/model-catalog");modelCatalog=result.models;$("modelMessage").textContent=`发现 ${modelCatalog.length} 个模型；已配置但未列出的模型需自行核实可用性。`+(result.warning ? " Pi 还报告了警告，请在终端核查。" : "");renderModelChoices();}
  catch(error){modelCatalog=[];$("modelMessage").textContent="读取失败：请检查 Pi 登录与网络；已保存配置不会改变。";renderModelChoices();}
  finally {$("reloadModels").disabled=false;}
}
$("openModels").addEventListener("click",async()=>{
  if (!connected || !modelSettings) return notice("先连接控制台并检查模型配置。");
  modelDraft=JSON.parse(JSON.stringify(modelSettings));$("modelScope").value="global";$("modelSearch").value="";openDialog($("modelDialog"));setTimeout(refreshScrollIndicators,0);renderModelChoices();await refreshModelCatalog();
});
$("closeModels").addEventListener("click",()=>closeDialog($("modelDialog")));
$("reloadModels").addEventListener("click",()=>void refreshModelCatalog());
$("modelScope").addEventListener("change",renderModelChoices);
$("modelSearch").addEventListener("input",renderModelChoices);
$("modelInherit").addEventListener("change",()=>{const scope=$("modelScope").value;if(scope==="global")return;modelDraft.roles[scope]=$("modelInherit").checked ? null : [];renderModelChoices();});
$("saveModels").addEventListener("click",async()=>{
  if (!modelDraft) return;
  if (Object.values(modelDraft.roles).some(x=>Array.isArray(x) && x.length===0)) {$("modelMessage").textContent="角色自定义配置至少选一个模型，或选择继承。";return;}
  if (!await askConfirm("保存后立即对接下来启动的任务生效（可能改变模型费用）。正在运行的任务保持原模型；手动安全停止后再启动会使用新配置。确定？"))return;
  try {const result=await api("/api/model-settings",{method:"POST",body:modelDraft});modelSettings=result.settings;closeDialog($("modelDialog"));notice("模型配置已保存：正在运行的任务不受影响，下次启动（含安全停止后重启）使用新配置。");await refresh();}
  catch(error){$("modelMessage").textContent="保存失败："+error.message;}
});

for (const lane of ["product","quality"]) {
  const cap=lane[0].toUpperCase()+lane.slice(1);
  $("open"+cap).addEventListener("click",()=>void openAdvisory(lane));
  $("close"+cap).addEventListener("click",()=>closeDialog($(lane+"Dialog")));
  $("run"+cap).addEventListener("click",()=>void startAdvisory(lane));
  $(lane+"Reports").addEventListener("change",()=>void loadAdvisory(lane,$(lane+"Reports").value));
  $(lane+"Copy").addEventListener("click",()=>{const report=currentReports[lane];if(report) void copyText(reportParts(report).map(p=>p.title+"\n"+p.text).join("\n\n"));});
  $(lane+"Delete").addEventListener("click",()=>void deleteAdvisory(lane,false));
  $(lane+"Clear").addEventListener("click",()=>void deleteAdvisory(lane,true));
}
$("themeToggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
$("openIntake").addEventListener("click",()=>{if(!connected)return notice("先连接本地控制台。");openDraft(null);});
$("closeIntake").addEventListener("click",()=>closeDialog($("intakeDialog")));
$("saveDraft").addEventListener("click",async()=>{if(await saveDraft()){closeDialog($("intakeDialog"));notice("草稿已保存。");}});
$("assessIntake").addEventListener("click",async()=>{if(!await askConfirm("评估会调用一次模型并可能产生费用，继续？"))return;const d=draftState.items.find(x=>x.id===editingDraft);if(!d||d.requirement!==$("requirement").value.trim()){if(!await saveDraft())return;}await draftAction("assess",{id:editingDraft});});
$("saveAnswers").addEventListener("click",async()=>{if(await saveDraftAnswers())notice("确认结果已保存。");});
$("reassessIntake").addEventListener("click",async()=>{
  if(!connected)return notice("先连接本地控制台。");
  if(!editingDraft)return notice("请先选择草稿。");
  if(!await askConfirm("将按已填写的待确认项重新评估可行性与实施安排，会产生一次模型调用。继续？"))return;
  const result=await draftAction("reassess",{id:editingDraft});
  if(result)notice("已提交重新评估；结果更新后会替换当前评估内容。");
});
$("submitIntake").addEventListener("click",async()=>{if(!await askConfirm("确认提交该需求？"))return;if(!await saveDraftAnswers())return;await draftAction("batch",{ids:[editingDraft]});});
$("batchDrafts").addEventListener("click",async()=>{const ids=[...selectedDrafts];if(!ids.length)return notice("请先选择已完成确认的草稿。");if(!await askConfirm(`确认按队列顺序提交 ${ids.length} 项需求？`))return;const result=await draftAction("batch",{ids});if(result){selectedDrafts.clear();lastDraftKey="";renderDrafts(result);}});
(function initializePreferences() {
  showPage(stored(preferenceStorage,PAGE_KEY) || "Overview");
  const theme = stored(preferenceStorage,THEME_KEY);
  setTheme(theme === "light" || theme === "dark" ? theme : "dark");
  const preferred = Number(stored(preferenceStorage, LOG_LIMIT_KEY));
  logLimit = LOG_LIMITS.has(preferred) ? preferred : 50;
  logFilter = ["all","system","stdout","stderr"].includes(stored(preferenceStorage,LOG_FILTER_KEY))
    ? stored(preferenceStorage,LOG_FILTER_KEY) : "all";
  followLogs = stored(preferenceStorage,FOLLOW_KEY) !== "false";
  $("logLimit").value = String(logLimit);
  $("logFilter").value = logFilter;
  $("followLogs").checked = followLogs;
})();
$("copyLogs").addEventListener("click",()=>void copyText(visibleLogs().map(row=>new Date(row.time).toLocaleTimeString()+" "+row.message).join("\n")));
$("logLimit").addEventListener("change", () => {
  const selected = Number($("logLimit").value);
  if (!LOG_LIMITS.has(selected)) return;
  logLimit = selected;
  save(preferenceStorage, LOG_LIMIT_KEY, logLimit);
  renderLogs(true);
});
$("logFilter").addEventListener("change", () => {
  logFilter = $("logFilter").value;
  save(preferenceStorage, LOG_FILTER_KEY, logFilter);
  renderLogs(true);
});
$("followLogs").addEventListener("change", () => {
  followLogs = Boolean($("followLogs").checked);
  save(preferenceStorage, FOLLOW_KEY, followLogs);
  if (followLogs) $("logs").scrollTop = $("logs").scrollHeight;
});
$("connect").addEventListener("click", () => void refresh());
tokenInput.addEventListener("keydown", event => { if (event.key === "Enter") void refresh(); });
tokenInput.addEventListener("input", () => {
  stopStream();
  connected = false;
  $("authPanel").hidden = false; $("connect").textContent = "连接";
  $("dot").classList.remove("ok");
  $("connection").textContent = "尚未连接";
  disableControls();
});
for (const button of document.querySelectorAll("[data-command]"))
  button.addEventListener("click", () => void execute(button.dataset.command));
$("publishButton").addEventListener("click", () => { $("publishMenu").hidden = !$("publishMenu").hidden; });
// 点气泡外部任意位置收起菜单（点击发布按钮本身交给上面的开关处理）。
document.addEventListener("click", event => {
  if ($("publishMenu").hidden) return;
  if (event?.target?.closest?.(".flip-wrap")) return;
  $("publishMenu").hidden = true;
});
for (const [id, mode] of [["publishPreview", "preview"], ["publishRelease", "release"]]) {
  $(id).addEventListener("click", async () => {
    if (!connected) return notice("先连接本地控制台。");
    const button = $(id);
    if (button.disabled) return;
    $("publishMenu").hidden = true;
    const label = mode === "preview" ? "发布 preview 版本（在集成分支打预发布 tag 并触发构建）" : "发布 release 版本（开 dev→main 的 PR，等必需检查通过后合并，再在 main 打 tag）";
    if (!await askConfirm(label + "？此操作会推送 tag 并触发 GitHub Actions 构建。")) return;
    buttonBusy(button, true);
    setTip(button, null);
    notice(mode === "release" ? "发布中：等必需检查通过后自动合并并打 tag，可能需要几分钟…" : "发布中：正在创建预发布 tag…");
    try {
      const result = await api("/api/publish", { method: "POST", body: { mode } });
      notice("发布完成：" + result.status + " · " + (result.tag ?? "") + (result.merge ? " · " + result.merge : ""));
      await refresh();
    } catch (error) { notice("发布失败：" + error.message); }
    finally { buttonBusy(button, false); }
  });
}
$("stop").addEventListener("click", async () => {
  if (!await askConfirm("请求优雅停止当前调度；工作树和检查点将保留。确定吗？")) return;
  try {
    await api("/api/stop", { method:"POST", body:{} });
    notice("已发送停止信号，等待当前 Runner 退出。");
    await refresh();
  } catch (error) { notice("停止失败：" + error.message); }
});
$("refresh").addEventListener("click", () => void refresh());
mountScrollIndicators();
setInterval(() => void refresh(), 15000);
setInterval(() => { if (!document.hidden) {updateElapsed();updateRunTimers();} }, 1000);
window.addEventListener("pagehide", stopStream);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void refresh();
    if (connected && !streamController && !reconnectTimer) void openStream(tokenInput.value.trim());
  }
});
$("closeMilestone").addEventListener("click",()=>closeDialog($("milestoneDialog")));
// 里程碑 / 产品 / 质量报告只读，没有输入：点外部直接关闭。
for (const id of ["milestoneDialog", "productDialog", "qualityDialog"])
  dismissOnBackdrop($(id), () => closeDialog($(id)));
const savedToken = restoreToken();
if (savedToken) {
  tokenInput.value = savedToken;
  void refresh();
}
