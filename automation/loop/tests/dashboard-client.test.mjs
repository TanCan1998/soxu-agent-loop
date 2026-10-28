import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const APP = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const TOKEN = "a".repeat(48);
const TOKEN_STORAGE_KEY = "soxu.dashboard.sessionToken.v1";
const STATUS = {
  generatedAt: "2026-10-27T00:00:00.000Z",
  tasks: [], runner: null, lastRun: null, externalLocks: 0,
  busy: false, log: [],
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function response(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return status === 200 ? STATUS : { error: "unauthorized" }; },
  };
}
function node() {
  const listeners = new Map(), children = [], attributes = {};
  const result = {
    value: "", textContent: "", disabled: false, checked: false, dataset: {}, className: "", style: {}, replacements:0, setAttribute(name, value) { attributes[name] = String(value); }, getAttribute(name) { return attributes[name] ?? null; },
    scrollTop: 0, scrollHeight: 0, clientHeight: 100,
    classList: { add() {}, remove() {}, contains(value) { return result.className.split(" ").includes(value); } },
    showModal() {result.open=true;}, close() {result.open=false;},
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    dispatch(type, event = {}) { listeners.get(type)?.(event); },
    get children() { return children; },
    get lastElementChild() { return children.at(-1); },
    get firstElementChild() { return children[0]; },
    replaceChildren(...items) { result.replacements++; children.splice(0,children.length,...items); for(const x of items) x.parent = result; },
    append(...items) { children.push(...items); for(const x of items) x.parent = result; },
    querySelectorAll(selector) { const all=[];const visit=n=>{for(const c of n.children || []){if(selector==='fieldset' && c.tagName==='fieldset' || selector==='input:checked' && c.tagName==='input' && c.checked)all.push(c);visit(c);}};visit(result);return all; },
    querySelector(selector) { const find=n=>{for(const c of n.children || []){if(c.tagName===selector)return c;const hit=find(c);if(hit)return hit;}return null;};return find(result); },
    remove() { if (result.parent) { const i = result.parent.children.indexOf(result); if (i >= 0) result.parent.children.splice(i,1); } },
    appendChild(item) { result.append(item); return item; },
    removeChild(item) { const i = children.indexOf(item); if (i >= 0) children.splice(i,1); },
  };
  return result;
}
function page({ storage = new Map(), handler = () => response(), hidden = false, preferences = new Map(), streamSupport = false, navigatorClipboard, execCommand = () => false, secureContext, confirmResult = true, promptResult = null } = {}) {
  const ids = [
    "milestoneDialog", "milestoneTitle", "milestoneDetails", "closeMilestone", "token", "tokenLabel", "authPanel", "authNotice", "connect", "notice", "connection", "dot", "globalRun", "running", "pending", "done",
    "total", "badge", "runner", "updated", "stop", "tasks", "logs", "refresh", "copyLogs", "intakeRunState", "productReports", "productCopy", "productDelete", "productClear", "qualityReports", "qualityCopy", "qualityDelete", "qualityClear",
    "navOverview", "navExecution", "navMonitor", "navRequirements", "navLanes", "navModels", "pageOverview", "pageExecution", "pageMonitor", "pageRequirements", "pageLanes", "pageModels", "modelSummary", "openModels", "closeModels", "reloadModels", "saveModels", "modelScope", "modelSearch", "modelInherit", "modelDialog", "modelGroups", "modelMessage", "logLimit", "logFilter", "followLogs", "logCount", "agentCards", "githubStatus", "autoMerge", "updateStatus", "updateTool", "taskFilters", "draftFilters", "milestoneFilters", "projectPhaseTasks",
    "publishButton", "publishMenu", "publishPreview", "publishRelease", "publishHint",
    "confirmDialog", "confirmTitle", "confirmMessage", "confirmInputLabel", "confirmInput", "confirmAccept", "confirmCancel", "confirmCancelTop", "projectPhaseTitle", "projectPhaseDetail", "projectPhaseCount", "roadmapCards", "developmentLane", "productLane", "qualityLane", "lessonsStatus", "openProduct", "openQuality", "productDialog", "qualityDialog", "closeProduct", "closeQuality", "runProduct", "runQuality", "productRunState", "qualityRunState", "productReport", "qualityReport", "projectProgress", "projectProgressFill", "themeToggle", "openIntake", "intakeDialog", "intakeSummary", "queueList", "closeIntake", "requirement", "assessIntake", "intakeResult", "queueReady", "intakeMilestone", "submitIntake", "clearIntake", "draftList", "batchDrafts", "saveDraft", "saveAnswers", "requirementField", "assessingHint", "reassessIntake",
  ];
  const elements = Object.fromEntries(ids.map(id => [id, node()]));
  const actions = ["start", "loop", "watch"].map(command => {
    const button = node();
    button.dataset.command = command;
    return button;
  });
  const listeners = new Map();
  const document = {
    hidden, documentElement: {dataset:{}},
    getElementById(id) { assert.ok(elements[id], `Unexpected element: ${id}`); return elements[id]; },
    querySelectorAll(selector) { if (selector === ".agent-elapsed") return []; if (selector === "[data-command], [data-resume-issue]") return [...actions, ...elements.tasks.children.flatMap(card => card.children.filter(child => child.dataset?.resumeIssue))]; assert.equal(selector, "[data-command]"); return actions; },
    createElement(tag) { const n=node();n.tagName=tag;return n; },
    createTextNode(value) { return { textContent: value }; },
    body: node(),
    execCommand(command) { return command === "copy" ? Boolean(execCommand()) : false; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    dispatch(type) { listeners.get(type)?.(); },
  };
  const requests = [], clipboard=[];
  // Default clipboard stub must be built inside the body: parameter defaults cannot see
  // the body-scoped `clipboard` binding.
  const navClipboard = navigatorClipboard === undefined ? { writeText: async text => clipboard.push(text) } : navigatorClipboard;
  const sessionStorage = {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  runInNewContext(APP, {
    document, navigator: navClipboard ? { clipboard: navClipboard } : {}, window:{addEventListener(){}, isSecureContext: secureContext}, ...(streamSupport ? {AbortController, TextDecoder} : {}), sessionStorage, localStorage: { getItem(key) { return preferences.get(key) ?? null; }, setItem(key, value) { preferences.set(key, String(value)); } },
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
    AbortSignal: { timeout() { return undefined; } },
    fetch: async (path, options) => {
      requests.push({ path, options });
      return handler(path, options);
    },
    confirm: () => true,
  }, { filename: "dashboard-app.js" });
  // 统一确认弹窗：测试里自动回答，保持既有流程不变。
  const baseShowModal = elements.confirmDialog.showModal;
  elements.confirmDialog.showModal = () => {
    baseShowModal();
    if (elements.confirmInput.hidden === false) {
      if (promptResult === null) { elements.confirmCancel.dispatch("click"); return; }
      elements.confirmInput.value = promptResult;
    }
    (confirmResult ? elements.confirmAccept : elements.confirmCancel).dispatch("click");
  };
  return { elements, actions, document, storage, requests, clipboard };
}

test("authenticated token survives same-tab reload and reconnects automatically", async () => {
  const storage = new Map();
  const first = page({ storage });
  first.elements.token.value = TOKEN;
  first.elements.connect.dispatch("click");
  await tick();
  assert.equal(first.elements.connection.textContent, "本机已连接");
  assert.equal(first.elements.authPanel.hidden, true);
  assert.equal(storage.get(TOKEN_STORAGE_KEY), TOKEN);

  const reloaded = page({ storage });
  await tick();
  assert.equal(reloaded.elements.token.value, TOKEN);
  assert.equal(reloaded.elements.connection.textContent, "本机已连接");
  const statusRequests = reloaded.requests.filter(x => x.path === "/api/status");
  assert.equal(statusRequests.length, 1);
  assert.equal(statusRequests[0].options.headers["X-SOXU-Control-Token"], TOKEN);
});

test("rejecting a token clears only the matching stored session", async () => {
  const storage = new Map([[TOKEN_STORAGE_KEY, TOKEN]]);
  const reloaded = page({ storage, handler: () => response(401) });
  await tick();
  assert.equal(storage.has(TOKEN_STORAGE_KEY), false);
  assert.equal(reloaded.elements.token.value, "");
  assert.equal(reloaded.elements.connection.textContent, "未连接");
  assert.equal(reloaded.elements.authPanel.hidden, false);
  assert.match(reloaded.elements.notice.textContent, /令牌已失效/);
  assert.ok(reloaded.actions.every(button => button.disabled));

  const incorrect = page({ storage, handler: () => response(401) });
  incorrect.elements.token.value = "b".repeat(48);
  incorrect.elements.connect.dispatch("click");
  await tick();
  assert.equal(storage.has(TOKEN_STORAGE_KEY), false);
});

test("temporary network errors retain the token and allow reconnection", async () => {
  const storage = new Map([[TOKEN_STORAGE_KEY, TOKEN]]);
  let available = false;
  const view = page({ storage, handler: () => {
    if (!available) throw new Error("network-unavailable");
    return response();
  } });
  await tick();
  assert.equal(storage.get(TOKEN_STORAGE_KEY), TOKEN);
  assert.equal(view.elements.connection.textContent, "连接中断");
  assert.equal(view.elements.authPanel.hidden, false);
  available = true;
  view.elements.refresh.dispatch("click");
  await tick();
  assert.equal(view.elements.connection.textContent, "本机已连接");
  assert.equal(view.elements.authPanel.hidden, true);
});

test("hidden-page reload restores the token when the page becomes visible", async () => {
  const storage = new Map([[TOKEN_STORAGE_KEY, TOKEN]]);
  const view = page({ storage, hidden: true });
  await tick();
  assert.equal(view.requests.length, 0);
  view.document.hidden = false;
  view.document.dispatch("visibilitychange");
  await tick();
  assert.equal(view.requests.filter(x => x.path === "/api/status").length, 1);
  assert.equal(view.elements.connection.textContent, "本机已连接");
});

test("invalid stored data is discarded without connecting", async () => {
  // "not-a-valid-token" is now acceptable (8-128 printable chars); use a truly invalid one.
  const storage = new Map([[TOKEN_STORAGE_KEY, "short"]]);
  const view = page({ storage });
  await tick();
  assert.equal(storage.has(TOKEN_STORAGE_KEY), false);
  assert.equal(view.requests.length, 0);
});

test("an earlier response cannot authenticate a newly edited token", async () => {
  const storage = new Map();
  let release;
  const view = page({ storage, handler: () => new Promise(resolve => { release = resolve; }) });
  view.elements.token.value = TOKEN;
  view.elements.connect.dispatch("click");
  await tick();
  view.elements.token.value = "b".repeat(48);
  view.elements.token.dispatch("input");
  release(response());
  await tick();
  assert.equal(storage.has(TOKEN_STORAGE_KEY), false);
  assert.notEqual(view.elements.connection.textContent, "本机已连接");
});

test("log settings show only latest 50 / 20 / 100 / 200 rows and remember preference", async () => {
  const preferences = new Map();
  const entries = Array.from({length:240},(_,i)=>({
    seq:i+1, time:"2026-10-27T00:00:00.000Z", message:"line "+i, stream:i%2?"stdout":"stderr"
  }));
  const view = page({preferences, handler: () => ({
    ok:true, status:200, json:async()=>({...STATUS,log:entries,instanceId:"test-server"})
  })});
  view.elements.token.value = TOKEN;
  view.elements.connect.dispatch("click");
  await tick();
  assert.equal(view.elements.logs.children.length,50);
  for(const expected of [20,100,200]){
    view.elements.logLimit.value = String(expected);
    view.elements.logLimit.dispatch("change");
    assert.equal(view.elements.logs.children.length,expected);
    assert.equal(preferences.get("soxu.dashboard.logLimit.v1"),String(expected));
  }
  view.elements.logFilter.value = "stderr";
  view.elements.logFilter.dispatch("change");
  assert.equal(view.elements.logs.children.length,120);
  assert.equal(preferences.get("soxu.dashboard.logFilter.v1"),"stderr");
});

test("log limit defaults to 50 after invalid local preference", async () => {
  const preferences=new Map([["soxu.dashboard.logLimit.v1","99999"]]);
  const view=page({preferences});
  assert.equal(view.elements.logLimit.value,"50");
});

test("start is the only launch command and blocked cards offer no per-task recovery", async () => {
  const snapshot = {...STATUS, tasks:[{id:1,title:"Supervisor",status:"blocked",phase:"checks"}]};
  const app = page({handler:(path)=> path === "/api/status" ? {ok:true, status:200, json:async()=>snapshot} : {ok:true,status:202,json:async()=>({command:"start"})}});
  app.elements.token.value=TOKEN; app.elements.connect.dispatch("click"); await tick();
  // Blocked tasks are handled by "start" together with paused ones.
  assert.equal(app.elements.tasks.children[0].children.find(x=>x.dataset.resumeIssue !== undefined), undefined);
  assert.deepEqual(app.actions.map(button=>button.dataset.command), ["start","loop","watch"]);
  app.actions[0].dispatch("click"); await tick();
  const request=app.requests.find(x=>x.path === "/api/run");
  assert.deepEqual(JSON.parse(request.options.body),{command:"start"});
  snapshot.busy=true; app.elements.refresh.dispatch("click"); await tick();
  assert.equal(app.actions[0].disabled,true);
});

test("task cards distinguish local completion, pending CI and dependencies", async () => {
  const snapshot={...STATUS, tasks:[{id:1,title:"One",status:"done"},{id:2,title:"Two",status:"pending"}], github:{status:"ok",updatedAt:"2026-10-27T00:00:00Z",tasks:{"TASK-001":{pr:{number:21,state:"open",ci:"pending"}},"TASK-002":{missing:["TASK-001"]}}}};
  const app=page({handler:()=>({ok:true,status:200,json:async()=>snapshot})});
  app.elements.token.value=TOKEN;app.elements.connect.dispatch("click");await tick();
  assert.match(app.elements.tasks.children[0].children.at(-1).children[0].textContent,/PR #21 待合并 · CI 运行中/);
  assert.match(app.elements.tasks.children[1].children.at(-1).textContent,/等待依赖合并：TASK-001/);
});

test("PR title links to GitHub and merge sends the selected issue and PR", async () => {
  const snapshot={...STATUS,tasks:[{id:1,title:"One",status:"done"}],github:{status:"ok",updatedAt:"2026-10-27T00:00:00Z",tasks:{"TASK-001":{issue:1,pr:{number:21,title:"Implement supervisor",url:"https://github.com/a/b/pull/21",state:"open",ci:"success"}}}}};
  const app=page({handler:path=>({ok:true,status:200,json:async()=>path==="/api/merge"?{merged:true,branchDeleted:true}:snapshot})});
  app.elements.token.value=TOKEN;app.elements.connect.dispatch("click");await tick();
  const detail=app.elements.tasks.children[0].children.at(-1), link=detail.children[0], button=detail.children.at(-1);
  assert.equal(link.textContent,"Implement supervisor");assert.equal(link.href,"https://github.com/a/b/pull/21");
  button.dispatch("click");await tick();
  assert.deepEqual(JSON.parse(app.requests.find(r=>r.path==="/api/merge").options.body),{issue:1,pr:21});
});

test("theme preference survives reload", async()=>{
  const preferences=new Map();const first=page({preferences});
  assert.equal(first.document.documentElement.dataset.theme,"dark");
  assert.equal(first.elements.themeToggle.dataset.nextTheme,"light");
  assert.equal(first.elements.themeToggle.getAttribute("aria-label"),"切换到浅色主题");
  first.elements.themeToggle.dispatch("click");
  assert.equal(first.elements.themeToggle.dataset.nextTheme,"dark");
  assert.equal(first.elements.themeToggle.getAttribute("aria-label"),"切换到深色主题");
  assert.equal(first.document.documentElement.dataset.theme,"light");
  const reloaded=page({preferences});
  assert.equal(reloaded.document.documentElement.dataset.theme,"light");
});

test("project milestones derive dynamic task counts and live evidence",async()=>{
  const stages=[{id:"M0",total:0,merged:0,paused:0,unknown:0,issues:[]},{id:"M1",total:3,merged:2,paused:0,unknown:0,issues:[1,2,3],items:[{number:1,title:"任务一",state:"CLOSED",url:"https://github.com/TanCan1998/SOXU/issues/1",labels:[],merged:true}]},{id:"M2",total:1,merged:0,paused:1,unknown:0,issues:[4]}];
  const snapshot={...STATUS,runner:{command:"once",startedAt:"2026-10-27T00:00:00Z"},taskPhases:[{taskId:3,status:"running"}],github:{status:"ok",updatedAt:"2026-10-27T00:00:00Z",tasks:{__roadmap:{stages,unclassified:2,limited:false}}}};
  const app=page({handler:()=>({ok:true,status:200,json:async()=>snapshot})});
  app.elements.token.value=TOKEN;app.elements.connect.dispatch("click");await tick();
  assert.equal(app.elements.projectPhaseTitle.textContent,"1 个里程碑正在推进");
  assert.equal(app.elements.projectPhaseCount.textContent,"2 / 4 项已合入");
  assert.equal(app.elements.roadmapCards.children[1].dataset.status,"running");
  app.elements.roadmapCards.children[1].dispatch("click");
  assert.equal(app.elements.milestoneDialog.open,true);
  assert.equal(app.elements.milestoneTitle.textContent,"M1 · 产品原型");
  assert.equal(app.elements.milestoneDetails.children[0].children[0].textContent,"#1 任务一");
  app.elements.closeMilestone.dispatch("click"); assert.equal(app.elements.milestoneDialog.open,false);
  assert.equal(app.elements.roadmapCards.children[2].dataset.status,"paused");
  snapshot.github={status:"unavailable"};app.elements.refresh.dispatch("click");await tick();
  assert.equal(app.elements.projectPhaseTitle.textContent,"项目里程碑状态待核实");
  assert.equal(app.elements.projectPhaseCount.textContent,"—");
});

test("SSE frame failure cancels and aborts old stream before reconnect", async () => {
  let cancelled=0, released=0, signal;
  const reader={read:async()=>({done:false,value:new Uint8Array(65537).fill(65)}), cancel:async()=>{cancelled++;},releaseLock:()=>{released++;}};
  const app=page({streamSupport:true,handler:(path,options)=>{
    if(path==="/api/events") {signal=options.signal;return {ok:true,status:200,body:{getReader:()=>reader}};}
    return response();
  }});
  app.elements.token.value=TOKEN;app.elements.connect.dispatch("click");
  await tick();await tick();
  assert.equal(signal.aborted,true);assert.equal(cancelled,1);assert.equal(released,1);
  app.elements.refresh.dispatch("click");await tick();await tick();
  assert.equal(app.requests.filter(r=>r.path==="/api/events").length,1,"status refresh must not bypass pending reconnect backoff");
});

test("unchanged agent snapshots do not rebuild DOM on every status poll",async()=>{
  const snapshot={...STATUS,agents:[{taskId:1,role:"developer",state:"waiting",tool:null,startedAt:"2026-10-27T00:00:00.000Z",activitySince:"2026-10-27T00:00:00.000Z"}]};
  const app=page({handler:()=>({ok:true,status:200,json:async()=>snapshot})});
  app.elements.token.value=TOKEN;app.elements.connect.dispatch("click");await tick();
  assert.equal(app.elements.agentCards.replacements,1);
  for(let i=0;i<100;i++){app.elements.refresh.dispatch("click");await tick();}
  assert.equal(app.elements.agentCards.replacements,1);
});

test("product and quality open separate report dialogs and run only on explicit click",async()=>{
  const report={lane:"product",summary:"建议",findings:[],unknowns:[],createdAt:"2026-10-27T00:00:00Z"};
  const app=page({handler:path=>({ok:true,status:200,json:async()=>path.includes("advisory-reports")?(path.includes("&name=")?{report}:{reports:[{name:"2026-10-27T00-00-00-000Z-123.json",modifiedAt:"2026-10-27T00:00:00Z"}]}):STATUS})});
  app.elements.token.value=TOKEN;app.elements.connect.dispatch("click");await tick();
  app.elements.openProduct.dispatch("click");await tick();
  assert.equal(app.elements.productDialog.open,true,app.elements.notice.textContent);
  assert.equal(app.requests.some(x=>x.path==="/api/advisory-run"),false);
  app.elements.runProduct.dispatch("click");await tick();
  assert.deepEqual(JSON.parse(app.requests.find(x=>x.path==="/api/advisory-run").options.body),{lane:"product"});
  app.elements.closeProduct.dispatch("click");app.elements.openQuality.dispatch("click");await tick();
  assert.equal(app.elements.qualityDialog.open,true);
  assert.ok(app.requests.some(x=>x.path==="/api/advisory-reports?lane=quality"));
});

test("navigation switches page without a network request or reload",async()=>{
  const preferences=new Map();const app=page({preferences});
  app.elements.navModels.dispatch("click");
  assert.equal(app.elements.pageModels.hidden,false);assert.equal(app.elements.pageOverview.hidden,true);
  assert.equal(app.requests.length,0);
  const again=page({preferences});assert.equal(again.elements.pageModels.hidden,false);
});

test("model picker groups providers, pins and saves selected global model",async()=>{
  const settings={schemaVersion:1,revision:0,global:[],roles:{developer:null,reviewer:null,product:null,quality:null,intake:null},favorites:[]};
  const snapshot={...STATUS,modelInfo:{status:"ok",settings,selected:{}}};
  const app=page({handler:(path,options)=>({ok:true,status:200,json:async()=>path==="/api/model-catalog"?{models:[{provider:"magpie",model:"a"},{provider:"other",model:"b"}]}:path==="/api/model-settings"?{settings:JSON.parse(options.body)}:snapshot})});
  app.elements.token.value=TOKEN;app.elements.connect.dispatch("click");await tick();
  app.elements.openModels.dispatch("click");await tick();
  assert.equal(app.elements.modelDialog.open,true);assert.equal(app.elements.modelGroups.children.length,2);
  let group=app.elements.modelGroups.children[0],row=group.children[1],input=row.children[0].children[0];
  input.checked=true;input.dispatch("change");row.children[1].dispatch("click");
  assert.match(app.elements.modelGroups.children[0].children[0].textContent,/已收藏/);
  app.elements.saveModels.dispatch("click");await tick();
  const body=JSON.parse(app.requests.find(x=>x.path==="/api/model-settings").options.body);
  assert.deepEqual(body.global,[{provider:"magpie",model:"a"}]);assert.deepEqual(body.favorites,[{provider:"magpie",model:"a"}]);
});

test("large model catalog limits rendered rows and keeps search available",async()=>{
  const settings={schemaVersion:1,revision:0,global:[],roles:{developer:null,reviewer:null,product:null,quality:null,intake:null},favorites:[]};
  const snapshot={...STATUS,modelInfo:{status:"ok",settings,selected:{}}};
  const models=Array.from({length:400},(_,i)=>({provider:"p",model:"model-"+String(i).padStart(3,"0")}));
  const app=page({handler:path=>({ok:true,status:200,json:async()=>path==="/api/model-catalog"?{models}:snapshot})});
  app.elements.token.value=TOKEN;app.elements.connect.dispatch("click");await tick();
  app.elements.openModels.dispatch("click");await tick();
  assert.equal(app.elements.modelGroups.children[0].children.length,301);
  assert.match(app.elements.modelGroups.children[1].textContent,/前 300/);
  app.elements.modelSearch.value="model-399";app.elements.modelSearch.dispatch("input");
  assert.equal(app.elements.modelGroups.children[0].children.length,2);
});

test("auto merge is policy-driven; the UI switch is gone", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /autoMerge|auto-merge/, "the switch and its endpoint must not be wired in the UI");
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="autoMerge"/);
});


test("copy logs uses the displayed filtered and limited rows",async()=>{
  const rows=Array.from({length:30},(_,i)=>({seq:i+1,stream:i%2?"stderr":"stdout",time:"2026-10-27T00:00:00Z",message:"message-"+i}));
  const app=page({handler:()=>({ok:true,status:200,json:async()=>({...STATUS,log:rows})})});
  app.elements.token.value=TOKEN;app.elements.connect.dispatch("click");await tick();
  app.elements.logFilter.value="stderr";app.elements.logFilter.dispatch("change");
  app.elements.copyLogs.dispatch("click");await tick();
  assert.equal(app.clipboard[0].split("\n").length,15);
  assert.match(app.clipboard[0],/message-1/);assert.doesNotMatch(app.clipboard[0],/message-2(?:\n|$)/);
});

test("copy falls back to execCommand when the page is not a secure context", async () => {
  const rows = [{ seq:1, stream:"stdout", time:"2026-10-27T00:00:00Z", message:"lan-message" }];
  // Android Chrome over plain HTTP: no navigator.clipboard, and the modern API would reject.
  const app = page({
    handler: () => ({ ok:true, status:200, json: async () => ({ ...STATUS, log: rows }) }),
    navigatorClipboard: null,
    execCommand: () => true,
  });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  app.elements.copyLogs.dispatch("click");
  await tick();
  assert.match(app.elements.notice.textContent, /已复制到剪贴板/);
});

test("copy reports a manual hint when the browser blocks every clipboard path", async () => {
  const rows = [{ seq:1, stream:"stdout", time:"2026-10-27T00:00:00Z", message:"lan-message" }];
  const app = page({
    handler: () => ({ ok:true, status:200, json: async () => ({ ...STATUS, log: rows }) }),
    navigatorClipboard: { writeText: async () => { throw new Error("not allowed"); } },
    execCommand: () => false,
    secureContext: false,
  });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  app.elements.copyLogs.dispatch("click");
  await tick();
  assert.match(app.elements.notice.textContent, /长按选择文本/);
});

test("completed requirements are grouped in a collapsed section", async () => {
  const assessment = { title:"已完成需求", feasibility:"可行", plan:"P", dependencies:"无", acceptance:"A", unknowns:"无", questions:[] };
  const items = [
    { id:"11111111-1111-4111-8111-111111111111", requirement:"这是仍在评审中的需求描述", status:"review", assessment, answers:[{selected:[],custom:"已确认"}] },
    { id:"22222222-2222-4222-8222-222222222222", requirement:"这是已经提交完成的需求", status:"submitted", assessment, url:"https://github.com/a/b/issues/9" },
  ];
  const app = page({ handler: () => ({ ok:true, status:200, json: async () => ({ ...STATUS, drafts:{ busy:false, items } }) }) });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  const rows = app.elements.draftList.children;
  // Active queue holds only the review item; the finished one is inside a closed details.
  assert.equal(rows.filter(row => row.tagName === "details").length, 1);
  const done = rows.find(row => row.tagName === "details");
  assert.equal(done.open, undefined);
  assert.match(done.children[0].textContent, /已完成需求 · 1 项/);
  assert.equal(done.children[1].children.length, 1);
  const active = rows.find(row => row.tagName !== "details");
  assert.equal(active.children[0].children[1].textContent.includes("已经提交完成"), false);
});

test("the requirement box is hidden while the agent evaluates", async () => {
  const assessment = { title:"评估中", feasibility:"可行", plan:"P", dependencies:"无", acceptance:"A", unknowns:"无", questions:[] };
  const id = "33333333-3333-4333-8333-333333333333";
  const app = page({ handler: path => path === "/api/drafts-save"
    ? { ok:true, status:200, json: async () => ({ busy:false, items:[{ id, requirement:"这段需求描述足够长", status:"assessing", startedAt:new Date().toISOString(), assessment }] }) }
    : { ok:true, status:200, json: async () => ({ ...STATUS, drafts:{ busy:false, items:[] } }) } });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  app.elements.openIntake.dispatch("click");
  app.elements.requirement.value = "这段需求描述足够长";
  app.elements.saveDraft.dispatch("click");
  await tick();
  await tick();
  assert.equal(app.elements.requirementField.hidden, true);
  assert.equal(app.elements.assessingHint.hidden, false);
});

test("dependencies render as a list with recognised task ids and questions fold with unknowns", async () => {
  const assessment = {
    title:"T", feasibility:"有条件可行", feasibilityStatus:"conditional", plan:"P",
    dependencies:"依赖项：TASK-001 先合并\n依赖项：TASK-002 再开始", acceptance:"A",
    unknowns:"部署平台", questions:[{ text:"部署平台", options:["Windows","Linux"] }],
  };
  const id = "44444444-4444-4444-8444-444444444444";
  const item = { id, requirement:"这是一个需要依赖与待确认的需求", status:"review", assessment };
  const app = page({ handler: () => ({ ok:true, status:200, json: async () => ({ ...STATUS, drafts:{ busy:false, items:[item] } }) }) });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  const edit = app.elements.draftList.children[0].children.find(node => node.textContent === "编辑");
  edit.dispatch("click");
  await tick();
  const blocks = app.elements.intakeResult.children;
  const dep = blocks.find(node => node.tagName === "details" && /前置依赖/.test(node.children[0].textContent));
  assert.ok(dep, "dependencies block missing");
  const depBody = dep.children[1];
  assert.match(depBody.children[0].textContent, /识别到前置任务：TASK-001、TASK-002/);
  assert.equal(depBody.children[1].children.length, 2);
  const unknowns = blocks.find(node => node.tagName === "details" && /未知与待确认/.test(node.children[0].textContent));
  assert.ok(unknowns, "unknowns block missing");
  assert.equal(unknowns.open, true);
  assert.ok(unknowns.children.some(node => node.tagName === "fieldset"), "questions must live inside the unknowns block");
});

test("answers enable a re-assessment that posts the draft id", async () => {
  const assessment = { title:"T", feasibility:"有条件可行", feasibilityStatus:"conditional", plan:"P", dependencies:"无", acceptance:"A", unknowns:"部署平台", questions:[{ text:"部署平台", options:["Windows","Linux"] }] };
  const id = "55555555-5555-4555-8555-555555555555";
  const item = { id, requirement:"这是需要重新评估可行性的需求", status:"review", assessment };
  const app = page({ handler: () => ({ ok:true, status:200, json: async () => ({ ...STATUS, drafts:{ busy:false, items:[item] } }) }) });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  app.elements.draftList.children[0].children.find(node => node.textContent === "编辑").dispatch("click");
  await tick();
  assert.equal(app.elements.reassessIntake.disabled, true, "needs answers first");
  const field = app.elements.intakeResult.querySelectorAll("fieldset")[0];
  field.querySelector("textarea").value = "Windows 11";
  field.dispatch("input");
  assert.equal(app.elements.reassessIntake.disabled, false);
  app.elements.reassessIntake.dispatch("click");
  await tick();
  const request = app.requests.find(x => x.path === "/api/drafts-reassess");
  assert.deepEqual(JSON.parse(request.options.body), { id });
});

test("milestone header lists active tasks, or upcoming ones when nothing is active", async () => {
  const stages = [{ id:"M2", name:"多 Agent", total:2, merged:1, running:0, paused:0, unknown:0, issues:[4,5], items:[] }];
  const running = { ...STATUS, tasks:[{id:4,title:"实现网络重试策略与超时预算（很长很长的标题）",status:"running"},{id:5,title:"已完成任务",status:"done"}], github:{ status:"ok",updatedAt:null,tasks:{__roadmap:{stages,unclassified:0,limited:false}} } };
  const app = page({ handler: () => ({ ok:true, status:200, json: async () => running }) });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  const label = app.elements.projectPhaseTasks.children[0];
  assert.equal(label.textContent, "活跃任务：");
  const chip = app.elements.projectPhaseTasks.children[1];
  assert.equal(chip.className, "phase-task-chip");
  assert.equal(chip.textContent, "实现网络重试策略与超时预算（很长很长的标题）");
  assert.equal(chip.title, "#4 实现网络重试策略与超时预算（很长很长的标题）");
  assert.equal(app.elements.projectPhaseTasks.children.length, 2, "only active tasks are chipped");

  const idle = { ...running, tasks:[{id:6,title:"待开始任务",status:"pending"}] };
  const view = page({ handler: () => ({ ok:true, status:200, json: async () => idle }) });
  view.elements.token.value = TOKEN;
  view.elements.connect.dispatch("click");
  await tick();
  assert.equal(view.elements.projectPhaseTasks.children[0].textContent, "即将进行的任务：");
  assert.equal(view.elements.projectPhaseTasks.children[1].textContent, "待开始任务");
});

test("task list filters by 全部 / 进行中 / 已完成", async () => {
  const snapshot = { ...STATUS, tasks:[{id:1,title:"甲",status:"running"},{id:2,title:"乙",status:"done"},{id:3,title:"丙",status:"blocked"}] };
  const app = page({ handler: () => ({ ok:true, status:200, json: async () => snapshot }) });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  const cards = () => app.elements.tasks.children.filter(node => node.className === "task");
  assert.equal(cards().length, 3);
  const pick = value => app.elements.taskFilters.children.find(button => button.dataset.filter === value);
  assert.equal(pick("all").getAttribute("aria-pressed"), "true");
  pick("done").dispatch("click");
  await tick();
  assert.equal(cards().length, 1);
  assert.equal(pick("done").getAttribute("aria-pressed"), "true");
  pick("active").dispatch("click");
  await tick();
  assert.equal(cards().length, 2);
});

test("requirement queue filters completed drafts", async () => {
  const assessment = { title:"T", feasibility:"可行", plan:"P", dependencies:"无", acceptance:"A", unknowns:"无", questions:[] };
  const items = [
    { id:"11111111-1111-4111-8111-111111111111", requirement:"进行中的需求描述", status:"review", assessment },
    { id:"22222222-2222-4222-8222-222222222222", requirement:"已完成的需求描述", status:"submitted", assessment, url:"https://github.com/a/b/issues/9" },
  ];
  const app = page({ handler: () => ({ ok:true, status:200, json: async () => ({ ...STATUS, drafts:{ busy:false, items } }) }) });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  const rows = () => app.elements.draftList.children.filter(node => node.className === "queue-item");
  assert.equal(rows().length, 1, "only the active draft is listed by default");
  app.elements.draftFilters.children.find(button => button.dataset.filter === "done").dispatch("click");
  await tick();
  const details = app.elements.draftList.children.find(node => node.tagName === "details");
  assert.ok(details, "completed section renders when filtering by 已完成");
  assert.equal(app.elements.draftList.children.filter(node => node.className === "queue-item").length, 0);
});

test("milestone detail filters by merge state", async () => {
  const stages = [{ id:"M2", name:"多 Agent", total:2, merged:1, running:0, paused:0, unknown:0, issues:[4,5], items:[
    { number:4, title:"未合入任务", state:"OPEN", labels:[], merged:false, url:null },
    { number:5, title:"已合入任务", state:"CLOSED", labels:[], merged:true, url:null },
  ] }];
  const snapshot = { ...STATUS, github:{ status:"ok", updatedAt:null, tasks:{ __roadmap:{ stages, unclassified:0, limited:false } } } };
  const app = page({ handler: () => ({ ok:true, status:200, json: async () => snapshot }) });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  const card = app.elements.roadmapCards.children.find(node => /M2/.test(node.getAttribute("aria-label") ?? ""));
  card.dispatch("click");
  await tick();
  const rows = () => app.elements.milestoneDetails.children.filter(node => node.className === "milestone-detail-row");
  assert.equal(rows().length, 2);
  app.elements.milestoneFilters.children.find(button => button.dataset.filter === "done").dispatch("click");
  await tick();
  assert.equal(rows().length, 1);
  assert.match(rows()[0].children[0].textContent, /已合入任务/);
});

test("milestone detail falls back to local checkpoints when GitHub is unavailable", async () => {
  const stages = [
    { id:"M0", name:"工程治理", total:0, merged:0, running:0, paused:0, unknown:0, issues:[], items:[] },
    { id:"M1", name:"产品原型", total:2, merged:2, running:0, paused:0, unknown:0, issues:[1,2], items:[
      { number:1, title:"任务一", state:"CLOSED", labels:[], merged:true, url:null, localStatus:"done" },
      { number:2, title:"任务二", state:"CLOSED", labels:[], merged:true, url:null, localStatus:"done" },
    ] },
  ];
  const snapshot = { ...STATUS, github:{ status:"unavailable", updatedAt:null, tasks:{} }, roadmap:{ source:"local", stages, unclassified:0, limited:false } };
  const app = page({ handler: () => ({ ok:true, status:200, json: async () => snapshot }) });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  const cards = app.elements.roadmapCards.children;
  assert.equal(cards.length, 5);
  assert.equal(cards[1].dataset.status, "completed");
  assert.match(app.elements.projectPhaseCount.textContent, /2 \/ 2 项已合入（本地推定）/);
  assert.match(app.elements.projectPhaseDetail.textContent, /本地检查点/);
  cards[1].dispatch("click");
  assert.equal(app.elements.milestoneDialog.open, true);
  assert.equal(app.elements.milestoneTitle.textContent, "M1 · 产品原型");
  const rows = app.elements.milestoneDetails.children;
  assert.match(rows[0].textContent, /GitHub 暂不可用/);
  assert.equal(rows.length, 3);
  assert.match(rows[1].children[0].textContent, /#1 任务一/);
  assert.equal(rows[1].children[1].textContent, "✓ 已合入");
  assert.equal(rows[1].children[1].dataset.state, "merged");
});

test("milestone detail distinguishes all six task states", async () => {
  const stages = [{ id:"M2", name:"多 Agent", total:6, merged:1, running:0, paused:0, unknown:0, issues:[1,2,3,4,5,6], items:[
    { number:1, title:"已合入", state:"CLOSED", labels:[], merged:true, url:null },
    { number:2, title:"关闭但未核实", state:"CLOSED", labels:[], merged:false, url:null },
    { number:3, title:"阻塞", state:"OPEN", labels:["agent:blocked"], merged:false, url:null },
    { number:4, title:"暂停", state:"OPEN", labels:["agent:paused"], merged:false, url:null },
    { number:5, title:"进行中", state:"OPEN", labels:["agent:in-progress"], merged:false, url:null },
    { number:6, title:"待处理", state:"OPEN", labels:["agent:ready"], merged:false, url:null },
  ] }];
  const snapshot = { ...STATUS, github:{ status:"ok", updatedAt:"2026-10-27T00:00:00Z", tasks:{ __roadmap:{ stages, unclassified:0, limited:false } } } };
  const app = page({ handler: () => ({ ok:true, status:200, json: async () => snapshot }) });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  const card = app.elements.roadmapCards.children.find(node => node.dataset.status !== undefined && /M2/.test(node.getAttribute("aria-label") ?? ""));
  card.dispatch("click");
  await tick();
  const chips = app.elements.milestoneDetails.children
    .filter(row => row.className === "milestone-detail-row")
    .map(row => row.children[1]);
  assert.deepEqual(chips.map(chip => chip.dataset.state), ["merged","unverified","blocked","paused","running","pending"]);
  assert.deepEqual(chips.map(chip => chip.textContent), ["✓ 已合入","⏳ 已关闭 · 合并待核实","⛔ 已阻塞","⏸ 已暂停","▶ 进行中","○ 待处理"]);
  // Six distinct colours are declared in the stylesheet for these keys.
  const css = await readFile(new URL("../web/style.css", import.meta.url), "utf8");
  for (const state of ["merged","unverified","blocked","paused","running","pending"]) {
    assert.match(css, new RegExp("\\.milestone-state\\[data-state=" + state + "\\]"), "missing colour rule for " + state);
  }
});

test("confirmations use the in-page dialog instead of native confirm/prompt/alert", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?<![\w.])confirm\(/, "native confirm() must not be used");
  assert.doesNotMatch(source, /(?<![\w.])prompt\(/, "native prompt() must not be used");
  assert.doesNotMatch(source, /(?<![\w.])alert\(/, "native alert() must not be used");
  assert.match(source, /askConfirm/);
});

test("cancelling the unified dialog aborts the action", async () => {
  const app = page({ confirmResult: false });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  app.actions.find(button => button.dataset.command === "start").dispatch("click");
  await tick();
  assert.equal(app.elements.confirmDialog.open, false, "dialog closes after answering");
  assert.equal(app.requests.filter(request => request.path === "/api/run").length, 0, "cancelling must not start a run");
});

test("active intake and advisory report show elapsed state",async()=>{
 const snapshot={...STATUS,intake:{status:"assessing",startedAt:new Date().toISOString()},advisory:{active:{lane:"product",startedAt:new Date().toISOString()},last:null}};
 const app=page({handler:()=>({ok:true,status:200,json:async()=>snapshot})});
 app.elements.token.value=TOKEN;app.elements.connect.dispatch("click");await tick();
 assert.match(app.elements.intakeRunState.textContent,/正在评估 · 已运行/);
 assert.match(app.elements.productRunState.textContent,/正在分析 · 已运行/);
 assert.equal(app.elements.productRunState.dataset.running,"true");
});

test("report copy includes full content and section copy is independent",async()=>{
 const report={lane:"product",summary:"摘要内容",findings:[{title:"建议一",recommendation:"操作",confidence:"high",evidence:["依据"]}],unknowns:["待确认"]};
 const filename="2026-10-27T00-00-00-000Z-123.json";
 const app=page({handler:path=>({ok:true,status:200,json:async()=>path.includes("&name=")?{report}:path.includes("advisory-reports")?{reports:[{name:filename,modifiedAt:"2026-10-27T00:00:00Z"}]}:STATUS})});
 app.elements.token.value=TOKEN;app.elements.connect.dispatch("click");await tick();
 app.elements.openProduct.dispatch("click");await tick();await tick();
 app.elements.productCopy.dispatch("click");await tick();
 assert.match(app.clipboard[0],/摘要内容/);assert.match(app.clipboard[0],/建议一/);assert.match(app.clipboard[0],/待确认/);
 const section=app.elements.productReport.children[1];section.children[0].children[1].dispatch("click");await tick();
 assert.match(app.clipboard[1],/摘要内容/);assert.doesNotMatch(app.clipboard[1],/建议一/);
});


test("draft review requires a selection or custom answer before submission",async()=>{
 const id="11111111-1111-4111-8111-111111111111";
 const assessment={title:"Test",feasibility:"可行",plan:"计划",dependencies:"任务：解释",acceptance:"验收",unknowns:"平台",questions:[{text:"平台",options:["Windows","Linux"]}]};
 const state={...STATUS,drafts:{busy:false,items:[{id,requirement:"一个足够长的需求描述内容",status:"review",assessment}]}};
 const app=page({storage:new Map([[TOKEN_STORAGE_KEY,TOKEN]]),handler:()=>({ok:true,status:200,json:async()=>state})});await tick();
 const row=app.elements.draftList.children[0];row.children.find(n=>n.textContent==="编辑").dispatch("click");
 assert.equal(app.elements.submitIntake.disabled,true);
 const field=app.elements.intakeResult.querySelectorAll("fieldset")[0];const custom=field.querySelector("textarea");custom.value="手工输入";field.dispatch("input");
 assert.equal(app.elements.submitIntake.disabled,false);
});

test("a fixed non-hex token connects and is restored from session storage", async () => {
  const fixed = "adminsoxuloop";
  const app = page({ handler: () => ({ ok: true, status: 200, json: async () => ({ ...STATUS }) }) });
  app.elements.token.value = fixed;
  app.elements.connect.dispatch("click");
  await tick();
  assert.equal(app.elements.authPanel.hidden, true);
  assert.equal(app.storage.get(TOKEN_STORAGE_KEY), fixed);
  // Short or spaced tokens are still rejected before any request is made.
  const bad = page({ handler: () => ({ ok: true, status: 200, json: async () => ({ ...STATUS }) }) });
  bad.elements.token.value = "short";
  bad.elements.connect.dispatch("click");
  await tick();
  assert.match(bad.elements.authNotice.textContent, /8–128 位/);
  assert.equal(bad.requests.length, 0);
});

test("the update button checks when current and applies when an update is available", async () => {
  // Available update: one click applies directly.
  const behind = { ...STATUS, protocolVersion: 1, update: { status: "ok", available: true, behind: 2, comparison: "main → origin/main", toolVersion: "0.1.0" } };
  const app = page({ handler: path => path === "/api/status"
    ? { ok: true, status: 200, json: async () => behind }
    : { ok: true, status: 200, json: async () => ({ status: "updated", previous: "11111111", current: "2222222222", toolVersion: "0.2.0", protocolVersion: 1, restarting: true }) } });
  app.elements.token.value = TOKEN;
  app.elements.connect.dispatch("click");
  await tick();
  assert.match(app.elements.updateStatus.textContent, /有更新可用 · behind 2 · main → origin\/main/);
  assert.match(app.elements.updateTool.title, /（可更新）/);
  app.elements.updateTool.dispatch("click");
  await tick();
  await tick();
  assert.deepEqual(app.requests.filter(request => request.path === "/api/update").map(request => JSON.parse(request.options.body).action), ["apply"]);
  assert.match(app.elements.updateStatus.textContent, /已更新到 22222222 · 控制台正在重启/);
  assert.match(app.elements.updateTool.title, /（无需更新）/);
  assert.equal(app.elements.updateTool.disabled, false);

  // Already current: the click only checks.
  const current = { ...STATUS, protocolVersion: 1, update: { status: "ok", available: false, behind: 0, comparison: "main → origin/main", toolVersion: "0.1.0" } };
  const view = page({ handler: path => path === "/api/status"
    ? { ok: true, status: 200, json: async () => current }
    : { ok: true, status: 200, json: async () => ({ status: "ok", available: false, behind: 0, comparison: "main → origin/main", protocolVersion: 1 }) } });
  view.elements.token.value = TOKEN;
  view.elements.connect.dispatch("click");
  await tick();
  assert.match(view.elements.updateTool.title, /（无需更新）/);
  view.elements.updateTool.dispatch("click");
  await tick();
  assert.deepEqual(view.requests.filter(request => request.path === "/api/update").map(request => JSON.parse(request.options.body).action), ["check"]);
  assert.match(view.elements.notice.textContent, /已是最新/);
});

test("the token survives a reload when sessionStorage was cleared (Android browsers)", async () => {
  // 雨见等安卓浏览器刷新后 sessionStorage 可能被清空，localStorage 仍在。
  const preferences = new Map([[TOKEN_STORAGE_KEY, TOKEN]]);
  const storage = new Map();
  const app = page({ storage, preferences, handler: () => ({ ok: true, status: 200, json: async () => ({ ...STATUS }) }) });
  await tick();
  assert.equal(app.elements.authPanel.hidden, true, "auto-connects from localStorage");
  assert.equal(storage.get(TOKEN_STORAGE_KEY), TOKEN, "sessionStorage is re-seeded");
  assert.equal(preferences.get(TOKEN_STORAGE_KEY), TOKEN, "localStorage keeps the token across reloads");
});

test("the publish menu gates release on dev being merged into main", async () => {
  const notMerged = { ...STATUS, publish: { integrationBranch: "dev", releaseBranch: "main", mergedIntoRelease: false, head: "main", clean: true, version: "0.1.0" } };
  const view = page({ handler: () => ({ ok: true, status: 200, json: async () => notMerged }) });
  view.elements.token.value = TOKEN;
  view.elements.connect.dispatch("click");
  await tick();
  // 人工通道：未合入也允许点击，服务端会先合并再打 tag。
  assert.equal(view.elements.publishRelease.disabled, false, "manual release does not require a prior merge");
  assert.match(view.elements.publishHint.textContent, /release 将开 dev→main 的 PR/);
  view.elements.publishPreview.dispatch("click");
  await tick();
  await tick();
  const request = view.requests.find(entry => entry.path === "/api/publish");
  assert.deepEqual(JSON.parse(request.options.body), { mode: "preview" });

  const merged = { ...STATUS, publish: { integrationBranch: "dev", releaseBranch: "main", mergedIntoRelease: true, head: "main", clean: true, version: "0.1.0" } };
  const ready = page({ handler: () => ({ ok: true, status: 200, json: async () => merged }) });
  ready.elements.token.value = TOKEN;
  ready.elements.connect.dispatch("click");
  await tick();
  assert.equal(ready.elements.publishRelease.disabled, false);
  assert.match(ready.elements.publishHint.textContent, /已合入 main/);

  // 走 PR 后不依赖本地检出：即使本机在 dev 也可发布，且不要求工作区干净。
  const elsewhere = { ...STATUS, publish: { integrationBranch: "dev", releaseBranch: "main", mergedIntoRelease: false, head: "dev", clean: false, version: "0.1.0" } };
  const portable = page({ handler: () => ({ ok: true, status: 200, json: async () => elsewhere }) });
  portable.elements.token.value = TOKEN;
  portable.elements.connect.dispatch("click");
  await tick();
  assert.equal(portable.elements.publishRelease.disabled, false, "release must not depend on local checkout state");
  assert.match(portable.elements.publishRelease.title, /PR/);
});

