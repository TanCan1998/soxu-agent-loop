/** app-copy.js：剪贴板三级降级、报告分节复制、advisory 报告加载与启动。 */
function legacyCopy(text) {
  if (!document.body) return false;
  const area = document.createElement("textarea");
  area.value = text;
  // 不设 readonly：部分 Android WebView 对 readonly 文本域拒绝 select()。
  // 不移出视口：某些浏览器认为不可见元素不可选中，用 1px + opacity:0 留在原位。
  // 尺寸不能太小：1px 宽的 textarea 装 8000+ 字符要排成 8000 行，
  // 渲染极慢且 Firefox 对极小元素的 execCommand 不可靠（返回 true 却没写进剪贴板）。
  // 用 200×80 + opacity 0.01 留在视口内，既满足「可见」要求又不拖慢排版。
  // 也不能用 opacity:0 / visibility:hidden / display:none：会被判定不可选中。
  area.setAttribute("aria-hidden", "true");
  area.style.cssText = "position:fixed;left:0;bottom:0;width:200px;height:80px;opacity:0.01;padding:0;border:0;outline:0;background:transparent;color:transparent;overflow:hidden;white-space:pre;z-index:-1;";
  document.body.appendChild(area);
  try {
    area.focus?.({ preventScroll: true });
    area.select?.();
    area.setSelectionRange?.(0, text.length);
    return Boolean(document.execCommand?.("copy"));
  } catch { return false; }
  finally { document.body.removeChild(area); }
}
/**
 * 复制文本。
 *
 * 顺序是踩出来的：
 *  - Firefox 的 document.execCommand("copy") 会返回 true 却不真的写剪贴板
 *    （元素再大、focus 再对也一样），所以不能把它当首选；
 *  - navigator.clipboard.writeText 可靠，但必须在用户手势的有效期内发起，
 *    一旦先 await 别的东西（哪怕只是 await 一个失败的 writeText），
 *    transient activation 就过期，Firefox 直接拒绝。
 *
 * 所以：先直接发起 writeText（不 await 前置操作），失败再退回 execCommand。
 */
function copyText(text) {
  if (!text) { notice("没有可复制的内容。"); return; }
  const clipboard = navigator.clipboard;
  if (window.isSecureContext !== false && clipboard?.writeText) {
    // 立即调用，不 await 任何前置异步操作，保住手势
    clipboard.writeText(text).then(
      () => notice("已复制到剪贴板。"),
      () => {
        if (legacyCopy(text)) { notice("已复制到剪贴板。"); return; }
        showCopyFallback(text);
      }
    );
    return;
  }
  if (legacyCopy(text)) { notice("已复制到剪贴板。"); return; }
  showCopyFallback(text);
}
/**
 * 复制兜底：环境禁止自动复制时，把文本放进可编辑框并全选。
 * 用户在弹窗里按 Ctrl+C / 长按「复制」即可拿到内容。
 */
function showCopyFallback(text) {
  const dialog = $("copyFallbackDialog");
  const area = $("copyFallbackText");
  if (!dialog || !area) { notice("此环境禁止自动复制，请手动选择文本。"); return; }
  area.value = text;
  openDialog(dialog);
  // 等弹窗动画起来再选中，否则部分浏览器选不中
  setTimeout(() => { try { area.focus(); area.select(); area.setSelectionRange(0, text.length); } catch { /* ignore */ } }, 120);
  notice("当前环境禁止自动复制，已选中全文，请按 Ctrl+C 或长按复制。");
}

/** 把结构化分段转成纯文本（整体复制与单条复制共用，避免字段漂移）。 */
function partToText(part) {
  if (part.kind === "summary") return part.text ?? "";
  if (part.kind === "unknowns") return (part.items ?? []).join("\n");
  return [
    part.impact ? "影响：" + part.impact : "",
    part.action ? "建议：" + part.action : "",
    part.evidence?.length ? "证据：\n" + part.evidence.join("\n") : "",
  ].filter(Boolean).join("\n");
}
/**
 * 复制图标：用内联 SVG，不用字符 ⧉ —— 那个字符在不同字体下形状差异很大，
 * 而且与页面其它图标（六点手柄等）风格不统一。
 */
const COPY_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5V2.5a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1"/></svg>';
function copyButton(text, label) {
  const button=element("button",undefined,"icon-button"); button.type="button";
  button.innerHTML=COPY_ICON;
  button.setAttribute("aria-label",label);setTip(button,label);
  button.addEventListener("click",event=>{event.stopPropagation();void copyText(text);});
  return button;
}
/**
 * 报告分段：结构化的 finding（含 impact/action/evidence），而不是拼成一大段文本。
 * 渲染侧据此做折叠 + 懒加载——一份 15KB 的报告全量渲染会产生数百个节点，
 * 打开对话框时明显卡顿。
 */
function reportParts(report) {
  const parts=[{kind:"summary",title:"摘要",text:report.summary}];
  for(const f of report.findings) parts.push({
    kind:"finding", title:f.title, confidence:f.confidence,
    impact:f.impact ?? "", action:f.action ?? f.recommendation ?? "",
    evidence:Array.isArray(f.evidence) ? f.evidence : [],
    // 兼容旧报告：没有 impact/action 时退回拼接文本
    legacy:!f.action && !f.recommendation ? "" : null,
  });
  if(report.unknowns?.length) parts.push({kind:"unknowns",title:"待核实",items:report.unknowns});
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
    for(const part of reportParts(report)) {
      if(part.kind==="finding") {
        // 折叠 + 懒加载：内容只在首次展开时构建，初始只渲染标题行。
        const details=element("details",undefined,"assessment-block");
        const summary=element("summary",undefined,"report-heading");
        // 标题与标签包在一个可收缩的容器里：
        // 标题过长时自己省略，不能把置信度标签挤出去（标题栏是 space-between，
        // 三个平级子元素会被推开，标签跑到中间）。
        const titleWrap=element("span",undefined,"report-title");
        // 等级标签放在标题文字左侧，先于标题 append
        if(part.confidence) {
          const level=String(part.confidence).toLowerCase();
          const badge=element("span",CONFIDENCE_LABEL[level] ?? part.confidence,"confidence-badge");
          badge.dataset.level=level;
          titleWrap.append(badge);
        }
        const strong=element("strong",part.title);
        strong.title=part.title;   // 溢出时悬浮显示完整标题
        titleWrap.append(strong);
        summary.append(titleWrap);
        // 复制单条：放折叠头里，点它不触发折叠（stopPropagation）。
        const copy=copyButton(part.title+"\n"+partToText(part),"复制"+part.title);
        copy.addEventListener("click",event=>event.stopPropagation());
        summary.append(copy);
        details.append(summary);
        details.addEventListener("toggle",()=>{
          if(!details.open) {
            // 关闭即回收：只靠懒加载解决首屏，一路展开仍会让 DOM 持续增长。
            const body=details.querySelector(".assessment-body");
            if(body) body.remove();
            details.dataset.filled="0";
            return;
          }
          if(details.dataset.filled==="1") return;
          details.dataset.filled="1";
          const body=element("div",undefined,"assessment-body");
          if(part.impact) body.append(element("p","影响："+part.impact));
          if(part.action) body.append(element("p","建议："+part.action));
          if(part.evidence.length) {
            const ul=element("ul",undefined,"evidence-list");
            for(const item of part.evidence) ul.append(element("li",item));
            body.append(ul);
          }
          details.append(body);
        });
        node.append(details);
        continue;
      }
      const block=element("div",undefined,"assessment-block");
      const head=element("div",undefined,"report-heading");
      const text=partToText(part);
      head.append(element("strong",part.title),copyButton(part.title+"\n"+text,"复制"+part.title));
      block.append(head,element("p",text));
      node.append(block);
    }
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
