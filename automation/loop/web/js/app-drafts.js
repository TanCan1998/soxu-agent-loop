/** app-drafts.js：需求录入——草稿编辑、答案收集、队列渲染、合并 PR 与命令执行。 */
function draftQuestions(a) {
  const raw=String(a?.unknowns || "").split(/\n+/).map(x=>x.replace(/^\s*(?:[-*•]|\d+[.、])\s*/, "").trim()).filter(x=>x && !NO_UNKNOWNS.test(x));
  const supplied=Array.isArray(a?.questions) ? a.questions : [];
  if(supplied.length===raw.length && raw.length) return supplied.map((q,i)=>({...q,text:raw[i]===q.text?q.text:raw[i]+" — "+q.text}));
  return [...raw.map(text=>({text,options:[]})),...supplied];
}
/** One draft row; shared by the active list and the collapsed completed section. */
function draftRow(d) {
  const row=element("div",undefined,"queue-item");
  row.dataset.draftId = d.id;
  row.setAttribute("data-draft-id", d.id); // closest() 依赖属性，dataset 同步在测试桩里不保证
  // 除"结果待核实/提交中"外都能排序；拖动走 Pointer 事件，触摸屏同样可用。
  row.dataset.draggable = ["unknown", "submitting"].includes(d.status) ? "0" : "1";
  if (row.dataset.draggable === "1") {
    // 字符 ⠿ 在很多系统字体里渲染得又小又虚，改用内联 SVG 六点手柄
    const handle = element("span", "", "drag-handle");
    handle.setAttribute("data-drag-handle", "");
    handle.setAttribute("aria-hidden", "true");
    handle.innerHTML = '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><circle cx="3" cy="3" r="1.4"/><circle cx="7" cy="3" r="1.4"/><circle cx="3" cy="8" r="1.4"/><circle cx="7" cy="8" r="1.4"/><circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/></svg>';
    row.append(handle);
  }
  const label=element("label"), box=element("input");box.type="checkbox";box.checked=selectedDrafts.has(d.id);box.disabled=d.status!=="review" || !Array.isArray(d.answers) || draftState.busy;box.addEventListener("change",()=>{if(box.checked)selectedDrafts.add(d.id);else selectedDrafts.delete(d.id);});label.append(box,document.createTextNode(" "+(d.assessment?.title || d.requirement.slice(0,60))+" · "+({draft:"草稿",review:d.answers?"可提交":"待确认",assessing:"评估中",submitting:"提交中",submitted:"已提交",unknown:"结果待核实"}[d.status]||d.status)));row.append(label);
  for(const [text,action,disabled] of [["编辑",()=>openDraft(d),["unknown","submitted","submitting"].includes(d.status)],["上移",()=>draftAction("move",{id:d.id,direction:-1}),false],["下移",()=>draftAction("move",{id:d.id,direction:1}),false],["删除",async()=>{if(await askConfirm("删除这个草稿？"))void draftAction("remove",{id:d.id});},d.status==="unknown"]]){const b=element("button",text);b.disabled=disabled||draftState.busy;b.addEventListener("click",action);row.append(b);}
  // 队列内直接切换 ready，不必进弹窗
  if(d.status==="review"){
    const readyBox=element("input");readyBox.type="checkbox";readyBox.checked=d.ready===true;readyBox.disabled=draftState.busy;
    readyBox.addEventListener("change",async()=>{try{await draftAction("ready",{id:d.id,ready:readyBox.checked});}catch(e){readyBox.checked=!readyBox.checked;notice("更新就绪状态失败："+e.message);}});
    const readyTag=element("label",undefined,"queue-ready-toggle");
    readyTag.append(readyBox,document.createTextNode(" 就绪"));
    row.append(readyTag);
    if(d.dependencyCheck && !d.dependencyCheck.ok && d.dependencyCheck.missing?.length)
      row.append(element("span","依赖缺失："+d.dependencyCheck.missing.join("、"),"queue-warn"));
  }
  // 依赖校验未通过：给一键重试，并说明缺什么
  if(d.status==="blocked"){
    const retry=element("button","重新提交");retry.disabled=draftState.busy;
    retry.addEventListener("click",async()=>{try{await draftAction("batch",{ids:[d.id]});notice("已重新提交，正在校验依赖。");}catch(e){notice("提交失败："+e.message);}});
    row.append(retry);
    const why=d.dependencyCheck?.missing?.length ? "依赖缺失："+d.dependencyCheck.missing.join("、") : (d.error || "依赖校验未通过");
    row.append(element("span",why,"queue-warn"));
  }
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
  const shownQueue = queueVisible.slice(0, listPageSize.queue);
  for (const item of shownQueue) {
    const row=element("div",undefined,"queue-item");
    row.setAttribute("data-issue-number", String(item.number));
    if (item.state === "OPEN") {
      row.dataset.draggable = "1";
      const handle = element("span", undefined, "drag-handle");
      handle.setAttribute("data-drag-handle", "");
      handle.setAttribute("aria-hidden", "true");
      // 与草稿行一致：用内联 SVG 六点手柄，字符 ⠿ 在多数系统字体下太虚
      handle.innerHTML = '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><circle cx="3" cy="3" r="1.4"/><circle cx="7" cy="3" r="1.4"/><circle cx="3" cy="8" r="1.4"/><circle cx="7" cy="8" r="1.4"/><circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/></svg>';
      row.append(handle);
    }
    const title=element(item.url ? "a" : "span",`#${item.number} ${item.title}`,"pr-link");
    if (item.url && /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(item.url)) {title.href=item.url;title.target="_blank";title.rel="noopener noreferrer";}
    const checkpoint=item.checkpoint;
    const live=(data.taskPhases || []).find(t=>t.taskId===item.number);
    // 状态描述与右侧开关必须同源，否则会出现「执行中」配「未就绪」的矛盾。
    // 唯一数据源 = 互斥的状态标签（agent:ready / waiting / in-progress / paused / blocked / pr），
    // checkpoint 只用来补阶段后缀，不再独立决定状态词。
    const AGENT_LABEL_TEXT = {
      "agent:ready": "就绪 · 等待认领",
      "agent:waiting": "等待前置任务",
      "agent:in-progress": "执行中",
      "agent:paused": "已暂停",
      "agent:blocked": "已阻塞",
      "agent:pr": "已交付 · 待合并",
    };
    const agentLabel = (item.labels || []).find(l => AGENT_LABEL_TEXT[l]);
    const phaseText = live?.phase ?? checkpoint?.phase ?? "";
    const closedText = item.merged ? "已关闭 · PR 已合并" : "已关闭 · 未找到合入记录";
    const state = item.state === "CLOSED"
      ? closedText
      : (AGENT_LABEL_TEXT[agentLabel] ?? "未开启 · 等待设为就绪") + (phaseText ? " · " + phaseText : "");
    row.append(title,element("span",state,"queue-state"));
    // ready 开关只在「可调度」的状态下出现：已就绪可取消，未开启/等依赖可开启。
    // 执行中 / 已暂停 / 已阻塞 / 已交付 不显示开关——那些状态由左侧文字说明，
    // 再挂一个「未就绪」只会自相矛盾。
    const SCHEDULABLE_LABELS = new Set([undefined, "agent:waiting", "agent:ready"]);
    if (item.state === "OPEN" && SCHEDULABLE_LABELS.has(agentLabel)) {
      const isReady = agentLabel === "agent:ready";
      const box = element("input");
      box.type = "checkbox";
      box.checked = isReady;
      // 用 class 表达选中态，不用 :has()（部分安卓 WebView 不支持）
      const tag = element("label", undefined, isReady ? "queue-ready-toggle on" : "queue-ready-toggle");
      const label = document.createTextNode(isReady ? " 就绪" : " 未就绪");
      const setState = on => {
        box.checked = on;
        if (on) tag.classList.add("on"); else tag.classList.remove("on");
        label.nodeValue = on ? " 就绪" : " 未就绪";
      };
      box.addEventListener("change", async () => {
        const want = box.checked;
        box.disabled = true;
        setState(want); // 乐观更新，先给出反馈
        try {
          const result = await api("/api/queue-ready", { method: "POST", body: { number: item.number, ready: want } });
          if (result?.ok) {
            notice(want ? `#${item.number} 已标为可执行。` : `#${item.number} 已取消可执行。`);
            lastQueueKey = "";
            await refresh();
          } else {
            setState(!want);
            const why = result?.missing?.length ? "依赖缺失 " + result.missing.join("、")
              : result?.reason === "issue-closed" ? "该需求已关闭"
              : result?.message ?? result?.reason ?? "未知原因";
            notice(`#${item.number} 不能标为可执行：` + why);
          }
        } catch (error) {
          setState(!want);
          notice("更新可执行状态失败：" + error.message);
        } finally {
          box.disabled = false;
        }
      });
      tag.append(box, label);
      row.append(tag);
    }
    queue.append(row);
  }
  if (queueVisible.length > shownQueue.length) {
    const rest = queueVisible.length - shownQueue.length;
    const more = element("button", "显示剩余 " + rest + " 项", "ghost");
    more.type = "button";
    more.addEventListener("click", () => {
      listPageSize.queue += LIST_PAGE_SIZE;
      lastQueueKey = "";
      renderQueue();
    });
    queue.append(more);
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

