/** app-infra.js：toast、统一确认弹窗、滚动指示、tooltip、授权失效处理。 */
function notice(message) {
  const toast = $("toast");
  if (toast) {
    toast.textContent = message;
    // 弹窗用 showModal() 会进入 top layer，普通 position:fixed 元素再高的 z-index
    // 也会被它和它的 backdrop 盖住（backdrop 还有 blur）。popover 同样在 top layer，
    // 且后显示的排在 dialog 之上。
    if (typeof toast.showPopover === "function") {
      // 必须每次先 hide 再 show：top layer 的顺序是「后进入者在上」，
      // 而 toast 一旦 open 就一直留在里面。后续再 showPopover() 会抛
      // InvalidStateError 被吞掉，于是打开弹窗（showModal 后进入）之后，
      // toast 仍排在 dialog 下面，看起来就是被遮住。
      try {
        if (toast.matches?.(":popover-open")) toast.hidePopover();
        toast.showPopover();
      } catch { /* 不支持或被拒绝 */ }
    } else {
      // 降级（浏览器不支持 popover，Chrome <114 / Firefox <125）：
      // 1) 必须先移除 popover 属性 —— 只要它还在，UA 的
      //    [popover]:not(:popover-open){display:none} 就会把 toast 藏起来；
      // 2) 再把 toast 挂进当前打开的 dialog。这样它落在 dialog 的层叠上下文里，
      //    不会被 dialog 自己盖住；position:fixed 不受祖先 overflow 裁剪，
      //    仍能贴到视口底部。
      if (toast.hasAttribute?.("popover")) toast.removeAttribute("popover");
      const dialog = document.querySelector?.("dialog[open]");
      const host = dialog ?? document.body;
      if (host && toast.parentElement !== host) host.appendChild(toast);
    }
    toast.dataset.show = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.dataset.show = "0"; }, 3600);
  } else {
    // 测试桩与旧结构没有 #toast，退回写 #notice 保持行为可断言
    const legacy = $("notice");
    if (legacy) legacy.textContent = message;
  }
  const auth = $("authNotice");
  if (auth) auth.textContent = message;
}
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
  // 先收指示条再播退场动画：关闭动画期间容器仍可见，
  // 如果等到 close 事件再重算，会看到发光条闪一下再消失。
  hideIndicatorsIn(dialog);
  // toast 可能在降级模式下被挂进了这个 dialog，关闭时移回 body，
  // 否则下一个 toast 会落在一个不可见的容器里。
  const toast = $("toast");
  if (toast && toast.parentElement === dialog) document.body.appendChild(toast);
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
    // 书卷式收合：向中线卷起（与进场 dialog-unroll 相反），clip-path 不缩放内容。
    animation = dialog.animate(
      [{ opacity: 1, clipPath: "inset(0 0 0 0 round 18px)", filter: "blur(0)" },
       { opacity: 0, clipPath: "inset(50% 0 50% 0 round 18px)", filter: "blur(6px)" }],
      { duration: 240, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" },
    );
    // finished 在 top-layer 元素被移除或动画被打断时可能永不 resolve，用超时兜底。
    animation?.finished?.then(done, done);
    setTimeout(done, 300);
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
  const scrollTarget = () => scroller ?? (document.scrollingElement || document.documentElement);
  const metrics = () => {
    // 移动端 WebView 里 window.scrollY 常为 0，必须以 scrollingElement.scrollTop 为准。
    const root = document.scrollingElement || document.documentElement;
    const rect = scroller ? scroller.getBoundingClientRect() : { top: 0, right: window.innerWidth, height: root.clientHeight };
    return {
      rect,
      top: scroller ? scroller.scrollTop : (root.scrollTop || window.scrollY || 0),
      view: scroller ? scroller.clientHeight : root.clientHeight,
      total: scroller ? scroller.scrollHeight : root.scrollHeight,
      visibleArea: scroller ? rect.height : root.clientHeight,
    };
  };
  const sync = () => {
    // 指示条始终 fixed 定位：容器滚动时 rect 不变，滚动只改变 thumb 的偏移。
    const { rect, top, view, total, visibleArea } = metrics();
    // 容器不可见时必须先摘掉 visible 再退出。
    // 弹窗关闭后 .model-groups 高度归零，若直接 return，指示条会留在页面上。
    if (!Number.isFinite(view) || !Number.isFinite(total) || view <= 0) { bar.classList.remove("visible"); return; }
    if (total <= view + 2 || visibleArea < 40) { bar.classList.remove("visible"); return; }
    const track = visibleArea - 8;
    const height = Math.max(28, Math.round(track * view / total));
    const offset = Math.round((track - height) * (top / (total - view)));
    bar.style.height = height + "px";
    bar.style.left = (rect.right - 14) + "px";
    bar.style.top = (rect.top + 4 + offset) + "px";
    bar.classList.add("visible", "active");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bar.classList.remove("active"), 900);
  };
  // 拖动滑块滚动页面：按位移比例映射到 scrollTop。
  // 同时支持 Pointer / Mouse / Touch 三套事件：部分 WebView 与自动化环境
  // 不会把鼠标事件合成为 pointer 事件，只用 pointerdown 会完全没反应。
  let drag = null;
  const beginDrag = (clientY, pointerId = null) => {
    if (drag) return;
    const { top, view, total, visibleArea } = metrics();
    if (!(total > view + 2)) return;
    const track = visibleArea - 8;
    const height = Math.max(28, Math.round(track * view / total));
    drag = {
      pointerId,
      startY: clientY,
      startTop: top,
      usable: Math.max(1, track - height),
      maxScroll: Math.max(1, total - view),
    };
    if (pointerId !== null) { try { bar.setPointerCapture?.(pointerId); } catch { /* unsupported */ } }
    bar.classList.add("dragging", "active");
    clearTimeout(hideTimer);
  };
  const moveDrag = clientY => {
    if (!drag) return;
    const next = drag.startTop + ((clientY - drag.startY) / drag.usable) * drag.maxScroll;
    scrollTarget().scrollTop = Math.max(0, Math.min(drag.maxScroll, Math.round(next)));
  };
  const endDrag = pointerId => {
    if (!drag) return;
    if (pointerId != null && drag.pointerId != null && pointerId !== drag.pointerId) return;
    if (drag.pointerId != null) { try { bar.releasePointerCapture?.(drag.pointerId); } catch { /* unsupported */ } }
    drag = null;
    bar.classList.remove("dragging");
  };
  bar.addEventListener("pointerdown", event => { event.preventDefault?.(); beginDrag(event.clientY, event.pointerId); });
  bar.addEventListener("pointermove", event => { if (event.pointerId !== drag?.pointerId) return; event.preventDefault?.(); moveDrag(event.clientY); });
  bar.addEventListener("pointerup", event => endDrag(event.pointerId));
  bar.addEventListener("pointercancel", event => endDrag(event.pointerId));
  bar.addEventListener("mousedown", event => { if (drag) return; event.preventDefault?.(); beginDrag(event.clientY); });
  window.addEventListener("mousemove", event => { if (drag) { event.preventDefault?.(); moveDrag(event.clientY); } });
  window.addEventListener("mouseup", () => endDrag());
  bar.addEventListener("touchstart", event => { if (drag) return; const t = event.touches?.[0]; if (t) { event.preventDefault?.(); beginDrag(t.clientY); } }, { passive: false });
  window.addEventListener("touchmove", event => { if (!drag) return; const t = event.touches?.[0]; if (t) { event.preventDefault?.(); moveDrag(t.clientY); } }, { passive: false });
  window.addEventListener("touchend", () => endDrag());
  window.addEventListener("touchcancel", () => endDrag());
  if (scroller) {
    scroller.addEventListener("scroll", sync, { passive: true });
  } else {
    window.addEventListener("scroll", sync, { passive: true });
    document.addEventListener("scroll", sync, { passive: true, capture: true });
    // 触摸滑动期间 scroll 事件可能被节流，touchmove 兜底刷新。
    window.addEventListener("touchmove", sync, { passive: true });
  }
  window.addEventListener("resize", sync);
  // 存容器与隐藏方法：弹窗关闭时要在动画开始前就把弹窗内的指示条收掉，
  // 否则会看到它「凭空出现又消失」——关闭动画期间容器还可见，重算会把它点亮。
  scrollIndicators.push({
    scroller,
    sync,
    hide: () => { bar.classList.remove("visible", "active"); },
  });
  sync();
  return sync;
}
function mountScrollIndicators() {
  try {
    // 触摸设备（安卓/平板）不画指示条：占位置又挡内容。
    // 除 media query 外再看 maxTouchPoints 与 UA，覆盖 media feature 不生效的 WebView。
    const mq = window.matchMedia;
    const touch = mq?.("(pointer: coarse)")?.matches
      || mq?.("(hover: none)")?.matches
      || (navigator.maxTouchPoints ?? 0) > 0
      || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent ?? "");
    if (touch) return;
    // 经典滚动条环境（桌面 Chrome/Edge）由 ::-webkit-scrollbar 负责，不重复画。
    if (window.innerWidth - document.documentElement.clientWidth > 0) return;
    // overlay 滚动条环境：原生滚动条会浮在自绘指示条之上，先把它彻底隐藏。
    document.documentElement.classList.add("overlay-scroll");
    mountScrollIndicator(null);
    for (const node of document.querySelectorAll(".model-groups")) mountScrollIndicator(node);
  } catch { /* 受限环境（无布局/测试桩）跳过，不影响页面逻辑 */ }
}
/** 弹窗开合会改变容器位置，重算一次指示条。 */
function refreshScrollIndicators() { for (const item of scrollIndicators) item.sync(); }
/** 容器即将隐藏（弹窗关闭）：立刻收掉它内部的指示条，不等重算。 */
function hideIndicatorsIn(container) {
  for (const item of scrollIndicators) {
    if (item.scroller && container?.contains?.(item.scroller)) item.hide();
  }
}
// 关闭弹窗后必须重算：弹窗内的滚动会让指示条带上 visible，
// 而 closeDialog 有多条退出路径（正常退场 / 强制关闭 / 已关闭直接返回），
// 逐个补调用容易漏。close 事件不冒泡，用捕获阶段统一接住。
document.addEventListener("close", event => {
  if (event.target instanceof HTMLDialogElement) refreshScrollIndicators();
}, true);
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
  $("globalRun").dataset.status="unknown"; $("globalRun").textContent="未连接";
  disableControls();
  stopStream();
  notice("访问令牌已失效或错误，请粘贴本次启动的新令牌。");
}
