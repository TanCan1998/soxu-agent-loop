/** app-base.js：DOM 快捷方式、存储键、展示标签与全局可变状态（其它片段共享同一作用域）。 */
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
const stateLabels = {
  running: "进行中", paused: "已暂停", blocked: "已阻塞", pending: "等待", done: "本地已结束",
  // 以下两项不是 task.status 的取值，而是由远端状态推导出的展示态
  completed: "已合入 · 待归档", archived: "已完成"
};
const phaseLabels = {
  worktree:"准备工作树", install:"安装依赖", develop:"开发", checks:"执行检查", review:"代码审查",
  postConflictInstall:"冲突后安装", recoveryInstall:"恢复时安装依赖", finalChecks:"最终检查", commit:"提交", push:"推送",
  createPr:"创建 PR", merge:"等待合并", done:"完成", archived:"已归档"
};
const activityLabels = { waiting:"等待模型", generating:"生成中", tool:"执行工具", completed:"已完成", failed:"失败" };
// 报告的置信度等级：原始值是 high/medium/low，界面显示中文
const CONFIDENCE_LABEL = { high:"高", medium:"中", low:"低" };
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
/**
 * 临时提示。
 *
 * 过去只写进 #notice —— 那是页面上的一段静态说明文字（宽高为 0，被折叠在面板里），
 * 于是「已复制到剪贴板」「报告还没加载完成」这类反馈用户根本看不到，
 * 看起来就像按钮没反应。现在写进真正的 toast。
 * #authNotice 仍然更新，因为连接失败时需要在连接卡片里看到原因。
 */
let toastTimer = null;
