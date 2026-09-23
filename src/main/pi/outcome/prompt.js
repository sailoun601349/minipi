/**
 * 「让模型只输出结构化 JSON」的提示词组装 + 模型回答的 JSON 解析。
 *
 * ## 为什么要有独立一层
 *
 * 产出链路调一次 LLM，**唯一目的**是拿到一段严格 JSON。但模型的天性是
 * 「爱说人话」——它会加 `好的，这是您的周报：` 前缀、会套 ```` ```json ```` 围栏、
 * 会末尾补一句 `如需调整请告诉我`。这些对「聊天」是优点，对「程序消费 JSON」是噪音。
 *
 * 所以这个模块负责两头：
 *   · **组装**：把「只准输出 JSON + 字段契约 + 一个 one-shot 示例 + 硬约束句」写死。
 *   · **解析**：把模型回答里的 JSON **剥**出来（去围栏、去前后解释），再 `JSON.parse`。
 *
 * 它**不做 schema 校验**——那是 `schema.js` 的职责。这里只管「把 JSON 文本变成对象」。
 *
 * 零依赖（不 import 任何东西），纯函数。
 *
 * 方案出处：`docs/minipi-v0.4-impl-plan.md` §3.1。
 */

/**
 * 输出契约（JSON 字段说明）。写成紧凑的 Schema 风格，模型对这类格式最敏感。
 * 单独抽出来是为了让「契约」在提示词里只出现一次，避免多处不一致。
 */
const SCHEMA_SPEC = `{
  "title": string,                       // 必填。产出物的标题，简短名词短语（≤120 字）
  "subtitle": string[] | string,         // 可选。副标题行，最多 2 行
  "sections": [                          // 必填。至少 1 节，最多 50 节
    {
      "heading": string,                 // 必填。该节标题
      "bullets": string[]                // 必填。该节条目，每条一句完整的话
    }
  ]
}`;

/**
 * one-shot 示例（输入 → 期望 JSON）。
 *
 * 为什么示例要**短**：示例越长，模型越倾向于照抄示例的结构与措辞（偷懒），
 * 而不是真整理用户的内容。一个恰好覆盖「title / subtitle / sections」
 * 三个字段的极简示例，既能示范格式，又不至于带偏内容。
 */
const ONE_SHOT_EXAMPLE = `示例 ——
用户意图：把这段聊天整理成周报
素材：今天修了登录接口的空指针；下午跟产品对了下个版本排期；明天要写完单元测试
期望输出：
{"title":"周报","subtitle":["2026-09-23"],"sections":[{"heading":"今日完成","bullets":["修复登录接口的空指针问题"]},{"heading":"明日计划","bullets":["完成单元测试的编写"]}]}`;

/**
 * 组装「结构化产出」提示词。
 *
 * 结构（顺序有意为之）：
 *   ① 角色与任务 —— 告诉模型「你在做结构化抽取，不是在聊天」
 *   ② 输出契约   —— 字段说明
 *   ③ one-shot   —— 一个短示例，示范格式
 *   ④ 硬约束句   —— 最后再说一遍「只输出 JSON」，紧贴用户素材，权重最高
 *   ⑤ 用户意图 + 素材 —— 用清晰分隔符分区块嵌入
 *
 * @param {object} input
 * @param {string} input.intent     用户那句「整理成周报」
 * @param {string} [input.sourceText] 素材（当前会话的近期内容；可能为空）
 * @param {"md" | "docx"} [input.format] 目标格式（一般不影响 JSON 结构，仅作上下文）
 * @returns {string} 完整提示词
 */
export function buildOutcomePrompt({ intent, sourceText, format } = {}) {
  const safeIntent = String(intent ?? "").trim() || "（未提供，请按素材自行判断产出主题）";
  const safeSource = String(sourceText ?? "").trim();
  const fmt = format === "docx" || format === "md" ? format : "docx";

  const sourceBlock =
    safeSource.length > 0
      ? `===== 素材开始 =====\n${safeSource}\n===== 素材结束 =====`
      : "===== 素材开始 =====\n（无额外素材，请仅依据用户意图生成结构）\n===== 素材结束 =====";

  return [
    "你是一个结构化产出抽取器。你的任务是把用户意图与素材整理成一份结构化的文档大纲。",
    "你**不是**在聊天，不要寒暄，不要解释你的思路，不要询问澄清问题。",
    "",
    "输出必须是一个 JSON 对象，字段契约如下（类型不要改）：",
    SCHEMA_SPEC,
    "",
    ONE_SHOT_EXAMPLE,
    "",
    `目标文件格式：${fmt}（这只影响字段内容风格，不影响上面的 JSON 结构）。`,
    "",
    "===== 用户意图 =====",
    safeIntent,
    "",
    sourceBlock,
    "",
    "===== 硬约束 =====",
    "只输出 JSON，不要 markdown 代码围栏，不要前后解释。",
    "第一个字符必须是 {，最后一个字符必须是 }。",
    "不要输出任何 JSON 之外的内容。",
  ].join("\n");
}

/**
 * 第一次校验失败后的「修正」提示词。
 *
 * 为什么要把 errors 列表原样回灌：模型看到「`sections 第 3 项的 bullets 不是数组`」
 * 这种**具体**报错，修正命中率远高于含糊的「格式不对，重来」。
 * 同时要求它「只输出修正后的完整 JSON」——防止它只回一个有问题的片段。
 *
 * @param {string[]} errors `validateOutcome` 给的错误列表（可读中文）
 * @returns {string} 修正用提示词
 */
export function buildRetryPrompt(errors) {
  const list = Array.isArray(errors) && errors.length > 0 ? errors : ["JSON 结构不符合契约"];
  return [
    "你上一次的输出不符合要求，请修正后重新输出。",
    "",
    "发现的问题：",
    ...list.map((e) => `  - ${String(e)}`),
    "",
    "要求：",
    "- 只输出修正后的**完整** JSON（不是片段、不是 diff）。",
    "- 不要 markdown 代码围栏，不要任何解释文字。",
    "- 第一个字符必须是 {，最后一个字符必须是 }。",
  ].join("\n");
}

/**
 * 从模型回答里剥出 JSON 文本。
 *
 * 处理顺序（每一步都对应一种真实会遇到的形态）：
 *   1. 剥 markdown 围栏：` ```json ... ``` ` / ` ``` ... ``` ` / 只有开围栏没闭围栏
 *   2. 兜底截取：从**第一个 `{`** 到**最后一个 `}`** 之间（干掉前后解释文字）
 *   3. `JSON.parse`
 *
 * 为什么先剥围栏再截 `{}`：如果先截 `{}`，围栏里的内容当然也在里面，能用；
 * 但先剥围栏能处理「围栏外还有文字」的复合情况，更稳。两步都做，能剥得更干净。
 *
 * ⚠ 本函数**不校验 schema** —— 解析成功只代表「是合法 JSON」，不代表字段对。
 *   字段校验是 `schema.js` 的事，两者职责分开，才好各自单测。
 *
 * @param {unknown} text 模型回答的原始文本
 * @returns {{ ok: boolean, value: unknown, errors: string[] }}
 *          `ok:false` 时 `value` 为 `null`
 */
export function parseOutcomeJson(text) {
  const raw = String(text ?? "");
  if (raw.trim().length === 0) {
    return { ok: false, value: null, errors: ["JSON 解析失败：模型返回为空"] };
  }

  let s = raw.trim();

  // ---- 1. 剥 markdown 围栏 ----
  // 匹配 ```json\n...\n``` / ```\n...\n``` / ```json\n...（无闭合）
  const fence = s.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
  if (fence && typeof fence[1] === "string") {
    s = fence[1].trim();
  } else if (s.startsWith("```")) {
    // 只有开围栏没闭合：去掉开头那行围栏
    s = s.replace(/^```(?:json|JSON)?\s*\n?/, "").trim();
  }

  // ---- 2. 截取第一个 { 到最后一个 } ----
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return { ok: false, value: null, errors: ["JSON 解析失败：未找到 JSON 对象"] };
  }
  const jsonText = s.slice(start, end + 1);

  // ---- 3. 解析 ----
  try {
    const value = JSON.parse(jsonText);
    return { ok: true, value, errors: [] };
  } catch (err) {
    // 错误信息里**只保留最简原因**，不带堆栈、不带大段原文（防敏感内容外泄）
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, value: null, errors: [`JSON 解析失败：${reason.slice(0, 200)}`] };
  }
}
