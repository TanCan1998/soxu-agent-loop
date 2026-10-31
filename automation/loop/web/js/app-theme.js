/** app-theme.js：运行计时与主题切换（View Transitions 圆形扩散）。 */
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
