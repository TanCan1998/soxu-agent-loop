/**
 * 里程碑（M 级）的唯一来源。
 *
 * 过去 M0–M4 写死在 8 个地方（正则、数组、名字表），导致：
 * - 新增 M5 需要改 8 处，漏一处就静默失效；
 * - 需求队列提交时 milestone 可空，落成「未归类」，dashboard 无法归类；
 * - 标题正则只认 M[0-4]，M5 的 issue 直接识别不到。
 *
 * 现在统一走这里：名字表可扩展，正则接受任意 M<数字>，
 * 未登记的名字用 id 兜底显示（不丢数据）。
 */

/** 已登记的里程碑名称。新增里程碑只需在这里加一行。 */
export const MILESTONE_NAMES = Object.freeze({
  M0: "工程治理",
  M1: "产品原型",
  M2: "多 Agent",
  M3: "开发工具",
  M4: "交付发布",
});

/** 任意 M 级：M0、M5、M12 都合法。 */
export const MILESTONE_ID = /^M\d+$/;

/** 从 issue 标题提取里程碑：[M1] [TASK-010] ... → "M1" */
export const MILESTONE_IN_TITLE = /^\[(M\d+)\](?:\s|$)/;

/** 从 GitHub milestone 字段提取：M1 / M1-产品原型 / M1: 产品原型 → "M1" */
export const MILESTONE_IN_FIELD = /^(M\d+)(?:\b|\s|\s*[-:])/i;

export function isMilestoneId(value) {
  return typeof value === "string" && MILESTONE_ID.test(value);
}

/** 显示名：未登记的 M 级直接显示 id，不显示「未归类」。 */
export function milestoneName(id) {
  return MILESTONE_NAMES[id] ?? String(id ?? "");
}

/** 把标题里的 [M?] 前缀换成目标里程碑（保留其余部分）。 */
export function retitleMilestone(title, milestone) {
  if (!isMilestoneId(milestone)) throw new Error("Invalid milestone id: " + milestone);
  const text = String(title ?? "").trim();
  const stripped = text.replace(MILESTONE_IN_TITLE, "").trim();
  return "[" + milestone + "] " + stripped;
}

/**
 * 汇总需要展示的里程碑 id：已登记的 + 实际数据里出现的，
 * 按数字序排列，保证新增 M5 后 dashboard 自动出现该卡片。
 */
export function stageIds(extraIds = []) {
  const ids = new Set(Object.keys(MILESTONE_NAMES));
  for (const id of extraIds) if (isMilestoneId(id)) ids.add(id);
  return [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}
