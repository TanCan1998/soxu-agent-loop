/** app-publish.js：发布按钮、错误码翻译、停止与下拉增强。 */
const PUBLISH_ERRORS = [
  ["external-runner-active", "有外部 Runner 正在这个仓库上运行，先停止它再发布"],
  ["runner-busy", "控制台还有任务在跑，等它结束或安全停止后再发布"],
  ["tag-exists", "该版本的 tag 已存在，先提升版本号再发布"],
  ["pr-not-clean-", "dev→main 的 PR 没能通过检查（合并状态不是 CLEAN），先处理冲突或分支保护"],
  ["ci-not-successful-on-", "目标分支上的 CI 没有成功，发布已中止"],
  ["timeout-waiting-for-", "等待超时（CI、PR 检查或分支推进），发布已中止，可稍后重试"],
  ["version-mismatch-", "版本号在不同清单之间不一致，先统一 package.json 与 tauri/Cargo 清单"],
  ["invalid-version", "版本号格式必须是 0.x.y"],
];
function publishErrorText(message) {
  const code = String(message ?? "");
  const hit = PUBLISH_ERRORS.find(([prefix]) => code.startsWith(prefix));
  return hit ? hit[1] + "（" + code + "）" : code;
}
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
    } catch (error) { notice("发布失败：" + publishErrorText(error.message)); }
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

/* ---------- 自定义下拉 ----------
   原生 select 在深色主题下样式无法控制：选项列表由系统绘制，不跟随页面配色，
   Android WebView 里还会盖住整个屏幕。这里用一层自定义 UI 包住原生 select，
   保留原 select 作为真值来源，所有既有代码不用改。 */
function enhanceSelect(select) {
  if (select.dataset.enhanced === "1") return;
  select.dataset.enhanced = "1";
  select.classList.add("native-select");
  const wrap = element("div", undefined, "mini-select");
  const button = element("button", undefined, "mini-select-button");
  button.type = "button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  const label = element("span", undefined, "mini-select-label");
  const caret = element("span", undefined, "mini-select-caret");
  caret.setAttribute("aria-hidden", "true");
  button.append(label, caret);
  const list = element("ul", undefined, "mini-select-list");
  list.setAttribute("role", "listbox");
  wrap.append(button, list);
  select.after(wrap);

  const syncLabel = () => {
    label.textContent = select.selectedOptions?.[0]?.textContent ?? "";
    button.disabled = select.disabled;
  };
  const rebuild = () => {
    list.replaceChildren();
    for (const opt of select.options) {
      const li = element("li", opt.textContent, "mini-select-option");
      li.setAttribute("role", "option");
      li.dataset.value = opt.value;
      if (opt.value === select.value) li.setAttribute("aria-selected", "true");
      li.addEventListener("click", () => {
        if (select.value !== opt.value) {
          select.value = opt.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        close();
        syncLabel();
      });
      list.append(li);
    }
    syncLabel();
  };
  const close = () => { wrap.dataset.open = "0"; button.setAttribute("aria-expanded", "false"); };
  const open = () => {
    // 同一时刻只开一个
    for (const other of document.querySelectorAll('.mini-select[data-open="1"]')) {
      if (other !== wrap) { other.dataset.open = "0"; other.querySelector(".mini-select-button")?.setAttribute("aria-expanded", "false"); }
    }
    wrap.dataset.open = "1";
    button.setAttribute("aria-expanded", "true");
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };
  button.addEventListener("click", event => {
    event.stopPropagation();
    if (wrap.dataset.open === "1") close(); else open();
  });
  document.addEventListener("click", event => { if (!wrap.contains(event.target)) close(); });
  // loadAdvisory 会重建 option，用 MutationObserver 跟上
  if (typeof MutationObserver === "function") new MutationObserver(rebuild).observe(select, { childList: true, subtree: true });
  select.addEventListener("change", syncLabel);
  rebuild();
}
// 用固定 ID 列表而不是 querySelectorAll("select")：测试环境的 DOM stub 只实现了
// 页面逻辑用到的少数 selector，通配查询会返回不可用的桩对象。
for (const id of ["logLimit", "logFilter", "intakeMilestone", "modelScope", "productReports", "qualityReports"]) {
  const sel = $(id);
  if (sel) { try { enhanceSelect(sel); } catch { /* 纯视觉增强，失败不影响功能 */ } }
}
