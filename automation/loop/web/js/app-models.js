/** app-models.js：模型目录加载、搜索、按 provider 分组与选择持久化。 */
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
/** 模型列表加载中的骨架占位：过去这里是一片空白，看不出在加载还是出错。 */
function renderModelSkeleton() {
  const container = $("modelGroups");
  if (!container) return;
  container.replaceChildren();
  for (let i = 0; i < 6; i++) {
    const row = element("div", undefined, "model-skeleton");
    row.setAttribute("aria-hidden", "true");
    // 宽度递减，看起来更像列表而不是一叠等宽条
    row.style.width = (92 - i * 6) + "%";
    container.append(row);
  }
  const hint = element("p", "正在读取模型列表…", "hint model-skeleton-hint");
  container.append(hint);
}
async function refreshModelCatalog() {
  $("modelMessage").textContent="正在读取本机 Pi 模型列表…";
  $("reloadModels").disabled=true;
  renderModelSkeleton();
  try {const result=await api("/api/model-catalog");modelCatalog=result.models;$("modelMessage").textContent=`发现 ${modelCatalog.length} 个模型；已配置但未列出的模型需自行核实可用性。`+(result.warning ? " Pi 还报告了警告，请在终端核查。" : "");renderModelChoices();}
  catch(error){modelCatalog=[];$("modelMessage").textContent="读取失败：请检查 Pi 登录与网络；已保存配置不会改变。";renderModelChoices();}
  finally {$("reloadModels").disabled=false;}
}
$("openModels").addEventListener("click",async()=>{
  if (!connected || !modelSettings) return notice("先连接控制台并检查模型配置。");
  modelDraft=JSON.parse(JSON.stringify(modelSettings));$("modelScope").value="global";$("modelSearch").value="";openDialog($("modelDialog"));setTimeout(refreshScrollIndicators,0);
  // 不要先 renderModelChoices：模型目录还没请求回来，先渲染只会闪一下「没有匹配模型」，
  // 把紧接着出现的加载骨架覆盖掉。refreshModelCatalog 内部会先铺骨架，成功后自己渲染。
  await refreshModelCatalog();
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
  $(lane+"Copy").addEventListener("click",()=>{const report=currentReports[lane];if(!report){notice("报告还没加载完成，请稍候再试。");return;}void copyText(reportParts(report).map(p=>p.title+"\n"+partToText(p)).join("\n\n"));});
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
$("batchDrafts").addEventListener("click",async()=>{const ids=[...selectedDrafts];if(!ids.length)return notice("请先选择已完成确认的草稿。");if(!await askConfirm(`确认按队列顺序提交 ${ids.length} 项需求？提交前会自动校验前置依赖。`))return;const result=await draftAction("batch",{ids});if(result){selectedDrafts.clear();lastDraftKey="";renderDrafts(result);const blocked=(result.items||[]).filter(x=>ids.includes(x.id)&&x.status==="blocked");if(blocked.length)notice("有 "+blocked.length+" 项依赖校验未通过，已标为阻塞并在列表中标出缺失项。");}});

/**
 * 已创建需求的拖动排序：拖动时直接重排 DOM，松手后把当前顺序整体提交。
 * 与草稿排序共用同一套 Pointer 事件写法（移动端可用）。
 */
(() => {
  const list = $("queueList");
  let drag = null;
  const rowAt = y => {
    for (const r of list.querySelectorAll?.("[data-issue-number]") ?? []) {
      const rect = r.getBoundingClientRect?.();
      if (!rect || !rect.height) continue;
      if (y >= rect.top && y <= rect.bottom) return r;
    }
    return null;
  };
  const onMove = event => {
    if (!drag || (event.pointerId != null && drag.pointerId != null && event.pointerId !== drag.pointerId)) return;
    if (!drag.active) {
      if (Math.abs(event.clientY - drag.startY) < 6) return;
      drag.active = true;
      drag.row.classList.add("dragging");
      document.body?.classList.add("dragging-draft");
    }
    event.preventDefault?.();
    const over = rowAt(event.clientY);
    if (over && over !== drag.row) {
      // 直接在 DOM 里挪动，拖动过程就能看到新顺序
      const rect = over.getBoundingClientRect?.();
      const after = rect && event.clientY > rect.top + rect.height / 2;
      over.parentNode?.insertBefore?.(drag.row, after ? over.nextSibling : over);
    }
    for (const r of list.querySelectorAll?.("[data-issue-number]") ?? []) {
      if (r === drag.row) r.classList.add("drop-target"); else r.classList.remove("drop-target");
    }
  };
  const onUp = async () => {
    if (!drag) return;
    const active = drag.active;
    const beforeOrder = drag.beforeOrder ?? [];
    drag.row.classList.remove("dragging", "drop-target");
    drag = null;
    document.body?.classList.remove("dragging-draft");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (!active) return;
    const order = [...(list.querySelectorAll?.("[data-issue-number]") ?? [])]
      .map(r => Number(r.getAttribute("data-issue-number")))
      .filter(n => Number.isSafeInteger(n) && n > 0);
    // 顺序没变就不发请求，避免无意义的写入和一次多余的刷新
    if (order.length === beforeOrder.length && order.every((n, i) => n === beforeOrder[i])) return;
    // 写入期间锁住所有手柄：置灰 + 屏蔽指针，防止半途再拖导致前后端顺序错位
    list.dataset.reordering = "1";
    const handles = [...(list.querySelectorAll?.("[data-drag-handle]") ?? [])];
    for (const h of handles) h.dataset.locked = "1";
    try {
      await api("/api/queue-reorder", { method: "POST", body: { order } });
      lastQueueKey = "";
      notice("需求顺序已保存，agent 会按此顺序认领。");
      await refresh();
    } catch (error) { notice("保存顺序失败：" + error.message); }
    finally {
      for (const h of handles) delete h.dataset.locked;
      delete list.dataset.reordering;
    }
  };
  list.addEventListener("pointerdown", event => {
    const handle = event.target?.closest?.("[data-drag-handle]");
    const row = handle?.closest?.("[data-issue-number]");
    if (!row || row.dataset.draggable !== "1") return;
    if (handle.dataset.locked === "1") return; // 上一次排序还在写入
    event.preventDefault?.();
    // 记下拖拽前的顺序，用于判断是否真的移动过
    const beforeOrder = [...(list.querySelectorAll?.("[data-issue-number]") ?? [])]
      .map(r => Number(r.getAttribute("data-issue-number")))
      .filter(n => Number.isSafeInteger(n) && n > 0);
    drag = { row, pointerId: event.pointerId ?? null, startY: event.clientY, active: false, beforeOrder };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
})();

/**
 * 拖动排序：按住行首的 ⠿ 手柄拖动。
 * 用 Pointer 事件（HTML5 drag 在移动端不触发），监听挂在 window 上、落点用行矩形判断，
 * 不依赖 pointer capture 与 elementFromPoint（这两者在部分 WebView 里不可靠）。
 * 移动超过 6px 才算拖动，避免把点击误判成排序。
 */
(() => {
  const list = $("draftList");
  let drag = null;
  const rows = () => [...list.querySelectorAll?.("[data-draft-id]") ?? []];
  const clear = () => {
    for (const r of rows()) r.classList.remove("dragging", "drop-target");
    document.body?.classList.remove("dragging-draft");
  };
  const rowAt = y => {
    for (const r of rows()) {
      const rect = r.getBoundingClientRect?.();
      if (!rect || !rect.height) continue;
      if (y >= rect.top && y <= rect.bottom) return r;
    }
    return null;
  };
  const onMove = event => {
    if (!drag || (event.pointerId != null && drag.pointerId != null && event.pointerId !== drag.pointerId)) return;
    if (!drag.active) {
      if (Math.abs(event.clientY - drag.startY) < 6) return;
      drag.active = true;
      drag.row.classList.add("dragging");
      document.body?.classList.add("dragging-draft");
    }
    event.preventDefault?.();
    const over = rowAt(event.clientY);
    drag.target = over && over !== drag.row ? over : null;
    for (const r of rows()) {
      if (r === drag.target) r.classList.add("drop-target");
      else r.classList.remove("drop-target");
    }
  };
  const onUp = async () => {
    if (!drag) return;
    const moved = drag.id, target = drag.target, active = drag.active;
    drag = null;
    clear();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (!active) return; // 只点了一下手柄，不排序
    const beforeId = target?.dataset.draftId ?? null;
    try {
      const result = await draftAction("reorder", { id: moved, beforeId });
      if (result) { lastDraftKey = ""; renderDrafts(result); notice("已按新顺序保存。"); }
    } catch (error) { notice("排序失败：" + error.message); }
  };
  list.addEventListener("pointerdown", event => {
    const handle = event.target?.closest?.("[data-drag-handle]");
    const row = handle?.closest?.("[data-draft-id]");
    if (!row || row.dataset.draggable !== "1") return;
    event.preventDefault?.();
    drag = { id: row.dataset.draftId, row, pointerId: event.pointerId ?? null, startY: event.clientY, active: false, target: null };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
})();
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
/* 发布失败大多是英文错误码，直接抛给用户看不懂。 */
