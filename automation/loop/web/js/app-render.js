/** app-render.js：任务/Agent 卡片、里程碑详情、项目阶段与整体快照渲染。 */
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
  const shownTasks = visible.slice(0, listPageSize.tasks);
  for (const task of shownTasks) {
    const card = element("article", undefined, "task");
    const live=Boolean(data.runner) && (data.taskPhases ?? []).some(p=>p.taskId === (data.github?.tasks?.["TASK-"+String(task.id).padStart(3,"0")]?.issue ?? task.id) && p.status === "running");
    const merged=data.github?.tasks?.["TASK-"+String(task.id).padStart(3,"0")]?.pr?.state === "merged";
    card.dataset.status=live ? "running" : ["paused","blocked"].includes(task.status) ? "paused" : merged ? "completed" : "waiting";
    // 按状态发光：运行中脉冲，暂停/阻塞橙色微光，已完成绿色微光（waiting 不加）。
  if (card.dataset.status !== "waiting") {const effect=element("div",undefined,"task-motion");effect.setAttribute("aria-hidden","true");card.append(effect);}
    card.append(element("div", "#" + task.id, "task-id"), element("div", task.title, "task-name"));
    // 状态文字必须和 card.dataset.status 同源。
    // 过去文字只读 task.status（本地 state 文件），而卡片状态还看了远端 merged，
    // 于是 PR 早已合并的任务会显示成「完成配色 + 等待两个字」。
    let displayState = task.status;
    if (task.phase === "archived") displayState = "archived";
    else if (merged) displayState = "completed";
    const status = element("div", stateLabels[displayState] || displayState, "task-state");
    status.dataset.state = displayState;
    // 时间带日期：只给时分秒的话，跨天的任务看不出是哪一天
    const stamp = task.updatedAt ? new Date(task.updatedAt) : null;
    // 手动拼 MM-DD HH:mm：zh-CN 的 toLocaleDateString 会给 10/28 这种斜杠格式
    const pad = n => String(n).padStart(2, "0");
    const timeText = stamp && !Number.isNaN(stamp.getTime())
      ? pad(stamp.getMonth() + 1) + "-" + pad(stamp.getDate()) + " " + pad(stamp.getHours()) + ":" + pad(stamp.getMinutes())
      : "—";
    // 阶段只对「还在执行」的任务有意义。
    // 已完成/已归档的任务显示阶段反而自相矛盾（曾出现「已合入 · 待归档」配「尚未开始」：
    // checkpoint 按 issue 号存、这里按 TASK 号查，永远查不到，phase 就退化成 null）。
    const finished = displayState === "completed" || displayState === "archived";
    // 已完成的任务不显示阶段：保留占位元素以免 grid 错位，但用 visibility 隐藏，
    // 连「阶段」这两个字的伪元素一起藏掉。
    const stage = element("div", finished ? "" : (phaseLabels[task.phase] || task.phase || "尚未开始"), "task-stage");
    if (finished) stage.dataset.empty = "1";
    card.append(status, stage, element("div", timeText, "task-time"));
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
  if (visible.length > shownTasks.length) {
    const rest = visible.length - shownTasks.length;
    const more = element("button", "显示剩余 " + rest + " 项", "ghost");
    more.type = "button";
    more.addEventListener("click", () => {
      listPageSize.tasks += LIST_PAGE_SIZE;
      lastTaskKey = "";
      renderTasks(lastSnapshot ?? data);
    });
    node.append(more);
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
    // 状态用颜色 + 小圆点区分，不再统一蓝色
    const stateNode = element("span", state + (activity.tool ? " · " + activity.tool : ""), "agent-state");
    stateNode.dataset.state = activity.state;
    item.append(element("strong", "#" + activity.taskId + " · " + role), stateNode);
    const elapsed = element("span", "", "agent-elapsed");
    elapsed.dataset.startedAt = activity.startedAt;
    elapsed.dataset.activitySince = activity.activitySince;
    // 已结束的 Agent 必须冻结耗时：否则 completed/failed 之后计时会一直涨。
    elapsed.dataset.state = activity.state;
    item.append(elapsed);
    const selected=actualModels.get(activity.taskId+":"+activity.role);
    if (selected) item.append(element("span", "模型："+(selected.provider && selected.model ? selected.provider+" / "+selected.model : "Pi 默认（具体模型未知）"),"agent-model"));
    node.append(item);
  }
  if (!entries.length) node.append(element("div", "暂无 Dashboard 启动的 Pi 会话活动", "empty"));
  updateElapsed();
}
function updateElapsed() {
  const pad = value => String(value).padStart(2, "0");
  const hms = seconds => Number.isFinite(seconds)
    ? pad(Math.floor(seconds / 3600)) + ":" + pad(Math.floor(seconds % 3600 / 60)) + ":" + pad(seconds % 60)
    : "—";
  const clock = timestamp => {
    const value = Date.parse(timestamp);
    return Number.isFinite(value) ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "—";
  };
  for (const label of document.querySelectorAll(".agent-elapsed")) {
    const started = Date.parse(label.dataset.startedAt);
    const since = Date.parse(label.dataset.activitySince);
    // 只有仍在跑的状态才需要实时累加；completed/failed 用最后一次活动时间当结束点。
    const finished = label.dataset.state === "completed" || label.dataset.state === "failed";
    if (!Number.isFinite(started)) { label.textContent = "耗时未知"; continue; }
    const end = finished && Number.isFinite(since) ? since : Date.now();
    const total = hms(Math.max(0, Math.floor((end - started) / 1000)));
    if (finished) {
      label.textContent = "耗时 " + total + " · 结束于 " + clock(label.dataset.activitySince);
    } else {
      const idle = hms(Number.isFinite(since) ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : NaN);
      label.textContent = "运行 " + total + " · 距上次活动 " + idle;
    }
  }
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
      : item.state === "CLOSED" ? { key:"unverified", label:"已关闭 · 未找到合入记录", icon:"⏳" }
      : item.labels.includes("agent:blocked") ? { key:"blocked", label:"已阻塞", icon:"⛔" }
      : item.labels.includes("agent:paused") ? { key:"paused", label:"已暂停", icon:"⏸" }
      : item.labels.includes("agent:in-progress") ? { key:"running", label:"进行中", icon:"▶" }
      : { key:"pending", label:"待处理", icon:"○" };
    const chip=element("span",state.icon+" "+state.label,"milestone-state");
    chip.dataset.state=state.key;
    // 「未找到合入记录」容易被读成异常，这里把成因写进 tooltip
    if(state.key==="unverified") setTip(chip,"issue 已关闭，但没有找到合并进集成分支的 PR 记录：可能是早期合入 main、PR 描述未写 Closes，或人工关闭。");
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
  // 单行显示，超出用省略号收尾；右侧给出总数，不再横向滚动。
  const shown = list.slice(0, 6);
  for (const task of shown) {
    const chip = element("span", task.title, "phase-task-chip");
    setTip(chip, "#" + task.id + " " + task.title);
    host.append(chip);
  }
  if (list.length > shown.length) host.append(element("span", "…", "phase-tasks-more"));
  host.append(element("span", "共 " + list.length + " 条", "phase-tasks-total"));
}
function renderProjectPhase(github, data) {
  // GitHub 不可用时退回本地检查点推出的路线图，避免整块变成"待核实"。
  const roadmap=github?.status === "ok" ? github.tasks?.__roadmap : (data.roadmap ?? null);
  // 里程碑名称由后端返回（roadmap.stages[].name）；这里只做兜底，
  // 未登记的 M 级直接显示 id，不再有「未归类」这一档。
  const names=Object.fromEntries((roadmap?.stages ?? []).map(s=>[s.id,s.name]));
  const key=JSON.stringify([roadmap,Boolean(data.runner),data.taskPhases]);
  if(key===lastRoadmapKey)return;
  lastRoadmapKey=key;
  const phases=new Set(data.runner ? (data.taskPhases ?? []).filter(p=>p.status === "running").map(p=>p.taskId) : []);
  const node=$("roadmapCards");node.replaceChildren();
  let running=0, paused=0, unknownCount=0, total=0, merged=0;
  // 待核实要单独统计：它和 running/paused 不是互斥关系。
  // M1 可能整体是 paused，但内部仍有 3 项完成证据待核实，只按状态计数会漏掉。
  let unverifiedMilestones=0, unverifiedTasks=0;
  for (const id of Object.keys(names)) {
    const stage=roadmap?.stages?.find(x=>x.id===id);
    const unknown=!roadmap || roadmap.limited || !stage || !stage.total;
    const active=!unknown && stage.issues.some(number=>phases.has(number));
    // 状态界定（优先级从高到低）：
  //   unknown  数据缺失（GitHub 不可用 / 无归类）
  //   running  有任务正在执行
  //   paused   有暂停或阻塞任务
  //   completed 全部合入且无待核实
  //   unverified 有「已关闭但找不到合入记录」的任务 —— 过去这一档被并进 waiting，
  //              导致卡片显示「等待推进」、点进明细却全是「未找到合入记录」
  //   waiting  其余（有未合入任务，但既没在跑也没卡住）
  const state=unknown ? "unknown"
    : active ? "running"
    : stage.paused ? "paused"
    : stage.merged===stage.total && !stage.unknown ? "completed"
    : stage.unknown > 0 ? "unverified"
    : "waiting";
    if(active)running++;else if(state==="paused")paused++;else if(state==="unknown")unknownCount++;
  if(!unknown && stage.unknown > 0){unverifiedMilestones++;unverifiedTasks+=stage.unknown;}
    if(!unknown){total+=stage.total;merged+=stage.merged;}
    const card=element("article",undefined,"milestone-card");card.dataset.status=state;
    card.setAttribute("role","button");card.setAttribute("tabindex","0");card.setAttribute("aria-label",id+" · "+names[id]+"，查看任务明细");
    const show=()=>showMilestoneDetail(id,names[id] ?? id,stage,Boolean(roadmap?.limited),roadmap?.source);
    card.addEventListener("click",show);card.addEventListener("keydown",event=>{if(event.key==="Enter" || event.key===" "){event.preventDefault();show();}});
    const labels={unknown:"待核实",running:"进行中",paused:"暂停 / 阻塞",completed:"任务已合入 · 验收待确认",unverified:"部分任务待核实",waiting:"等待推进"};
    const head=element("div",undefined,"milestone-heading");head.append(element("strong",id+" · "+(names[id] ?? id)),element("span",labels[state],"milestone-state"));card.append(head);
    const track=element("div",undefined,"milestone-track"), fill=element("span",undefined,"milestone-fill");
    track.setAttribute("role","progressbar");track.setAttribute("aria-label",id+" 已归类任务的合入进度");
    if(!unknown){track.setAttribute("aria-valuemin","0");track.setAttribute("aria-valuemax",String(stage.total));track.setAttribute("aria-valuenow",String(stage.merged));fill.style.width=`${stage.merged/stage.total*100}%`;}
    track.setAttribute("aria-valuetext",unknown ? "未知" : `${stage.merged} / ${stage.total} 项已合入${active ? "，执行进度未知" : ""}`);
    track.append(fill);if(active){const motion=element("span",undefined,"milestone-motion");motion.setAttribute("aria-hidden","true");track.append(motion);}card.append(track);
    card.append(element("small",unknown ? "暂无完整的归类与合并证据" : `${stage.merged} / ${stage.total} 项已合入`+(stage.unknown ? ` · ${stage.unknown} 项完成证据待核实` : ""),"hint"));
    node.append(card);
  }
  const local = roadmap?.source === "local";
  // 过去这里是互斥三元：有 running 就只报 running，没 running 才报 paused，
  // 待核实（unverified）与数据缺失（unknown）从不出现。现在并列陈述各自的数量。
  const parts=[];
  if(running)parts.push(`${running} 个正在推进`);
  if(paused)parts.push(`${paused} 个暂停或阻塞`);
  if(unverifiedMilestones)parts.push(`${unverifiedMilestones} 个里程碑共 ${unverifiedTasks} 项待核实`);
  if(unknownCount)parts.push(`${unknownCount} 个归类待确认`);
  $("projectPhaseTitle").textContent=!roadmap ? "项目里程碑状态待核实"
    : parts.length ? parts.join(" · ")
    : "已归类里程碑当前无活跃任务";
  $("projectPhaseCount").textContent=roadmap && !roadmap.limited ? `${merged} / ${total} 项已合入${local ? "（本地推定）" : ""}` : "—";
  renderPhaseTasks(data);
  $("projectPhaseDetail").textContent=!roadmap ? "GitHub 与本地检查点都没有可用的里程碑数据。" : roadmap.limited ? "GitHub 查询达到上限，进度待核实。" : local ? "GitHub 暂不可用，以上按本地检查点与任务文件推定；合入与验收仍需在 GitHub 复核。" : "按任务元数据或 GitHub 里程碑自动归类；运行状态基于控制台活动，数据可能有延迟。";
}

function render(data) {
  if (typeof data.instanceId === "string") resetInstance(data.instanceId);
  connected = true;
  $("authPanel").hidden = true;
  const tasks = data.tasks || [];
  for (const group of ["running", "pending", "done"]) $(group).textContent = tasks.filter(t => t.status === group).length;
  $("total").textContent = tasks.length;
  const blocked=tasks.filter(t=>t.status === "blocked" || t.status === "paused").length;
  $("globalRun").dataset.status=data.runner || data.externalLocks ? "running" : blocked ? "paused" : "idle";
  $("globalRun").textContent=data.runner ? "调度运行中" : blocked ? `${blocked} 项暂停 / 阻塞` : "调度空闲";
  $("badge").dataset.state = data.runner ? (data.runner.stopping ? "stopping" : "running") : data.externalLocks ? "external" : "idle";
  $("badge").textContent = data.runner ? (data.runner.stopping ? "停止中" : "运行中") : "空闲";
  $("runner").textContent = data.runner ? "正在执行 " + data.runner.command + " · 开始于 " + new Date(data.runner.startedAt).toLocaleTimeString()
    : data.externalLocks ? "检测到 " + data.externalLocks + " 个任务锁由其他进程持有（PID 仍存活，此处不能停止）"
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
