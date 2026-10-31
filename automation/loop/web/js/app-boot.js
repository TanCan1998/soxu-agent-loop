/** app-boot.js：定时器、生命周期事件绑定与启动连接（必须最后加载）。 */
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
$("closeCopyFallback")?.addEventListener("click",()=>closeDialog($("copyFallbackDialog")));
dismissOnBackdrop($("copyFallbackDialog"), () => closeDialog($("copyFallbackDialog")));
// 里程碑 / 产品 / 质量报告只读，没有输入：点外部直接关闭。
for (const id of ["milestoneDialog", "productDialog", "qualityDialog"])
  dismissOnBackdrop($(id), () => closeDialog($(id)));
const savedToken = restoreToken();
if (savedToken) {
  tokenInput.value = savedToken;
  void refresh();
}

