/** app-nav.js：页面切换、更新徽章、GitHub 状态与工具热更新。 */
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
