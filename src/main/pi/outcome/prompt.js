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
 * 提示词硬顶 —— **必须与 `shared/protocol.js` 的 `LIMITS.PROMPT_MAX_CHARS` 保持一致（32000）**。
 *
 * 为什么不直接 import 那个常量：本模块是**零依赖纯函数**层（可被任意环境单独拉起做单测，
 * 也是它当初不 import 任何东西的原因）。所以这里只能自己写一份，并在注释里钉住同步责任。
 *
 * 为什么必须在这里就压住：`session.js:generateStructured()` 对超长 instruction 是
 * **硬抛 `INVALID_ARGUMENT`**（不是降级）⇒ 提示词超顶 = 导出直接失败，用户什么也拿不到。
 */
const MAX_PROMPT_CHARS = 32000;

/**
 * 回灌「上一次输出」的长度上限。
 *
 * 取**头部**而不是尾部：模型回的是 JSON，从 `{` 开始，砍掉头等于砍掉契约起点。
 *
 * 为什么是 20000 而不是更小的值：修正要求是「输出**完整** JSON」，若只贴头部，
 * 尾部章节会被静默砍掉，模型照着残片补完**照样能过校验** ⇒ 用户拿到少了几节的成稿，
 * 而且没有任何降级标记。宁可让极长输出多占点 token，也不要静默丢内容。
 *
 * ⚠ 这只是**上限**，真正能贴多少由 `buildRetryPrompt()` 里「先量后切」算出来的 `room` 决定。
 */
const PREV_OUTPUT_MAX_CHARS = 20000;

/**
 * 回灌「上一次输出」的**最小可用**长度。
 *
 * 额度不够时不是「能贴多少贴多少」，而是「够不够像一份原稿」：
 * 只剩几百字的时候，贴给模型的是半个字段名（`{"title":"周报","sections":[{"head`），
 * 而文案同时写着「这是你上一次的输出」+「请输出**完整** JSON」——
 * 模型极可能顺着残片**补完**而不是**修正**，用户拿到的就是一份悄悄缺了章节的成稿。
 * 与其塞个假原稿，不如明说「上一次输出过长，已省略」，让它按 base（意图 + 素材 + 契约）重写。
 *
 * 2000 的依据：一份能成为「原稿」的最小产出，至少要装得下标题 + 两三节的 heading/bullets；
 * 再少就只剩结构骨架，修正价值低于误导风险。
 */
const PREV_OUTPUT_MIN_CHARS = 2000;

/**
 * 第一次校验失败后的「修正」提示词。
 *
 * 为什么要把 errors 列表原样回灌：模型看到「`sections 第 3 项的 bullets 不是数组`」
 * 这种**具体**报错，修正命中率远高于含糊的「格式不对，重来」。
 * 同时要求它「只输出修正后的完整 JSON」——防止它只回一个有问题的片段。
 *
 * ## 为什么还要把「完整产出要求」重新贴一遍（`context`）
 *
 * 导出走的是 `completeSimple` **一次性调用**：第二次请求是一条全新对话，
 * 模型既看不到上一轮自己写了什么，也**看不到用户那句意图**与素材。
 * 只回灌 errors + 残片的话，它不知道「要把什么整理成周报」——首版为空时重试必然写废，
 * 直接掉进降级①。所以有 `context.intent` 时**复用 `buildOutcomePrompt()`**（不复制提示词）
 * 把基准要求整段重贴，让重试请求自己就是一份完整请求。
 *
 * ## 为什么还要把上一次的输出本身贴回来（`prevText`）
 *
 * 同上：模型**看不到**上一轮输出。只回灌 errors 等于让它凭空重写一遍，
 * 既不知道错在哪段文本，也无法「在原稿上改」。
 *
 * ## 长度：先量后切（⚠ 别改回「扣一个固定余量」）
 *
 * 这里的长度是**双向**约束：超 `MAX_PROMPT_CHARS` 会被 `generateStructured` 硬拒
 * （`INVALID_ARGUMENT`，`OutcomeService.generate()` 不 catch ⇒ 整次导出失败，连降级①都没有）；
 * 切太狠又等于砍内容。所以不能靠拍脑袋的常数预留 —— 上一版用固定
 * `RETRY_OVERHEAD_RESERVE = 1200`，遇到「大素材 + 50 条 errors」实测拼出 33k 直接超顶。
 *
 * 现在改成**同一段拼装逻辑量两遍**：
 *   ① `assemble("")` ⇒ 量出固定部分（base + 修正块 + **完整 errors 列表**）的真实长度；
 *   ② `assemble("X")` ⇒ 再量出「上一轮输出块」的包装开销（说明行 + 上下分隔 + 空行）；
 *   ③ 剩余额度 `room = MAX_PROMPT_CHARS − fixed − overhead` 才是 prev 的。
 * 末尾还有一道「拼出来再核一次、超了就再切」的收敛，保证**永不返回超顶字符串**：
 * 宁可少贴一点上一轮输出，也不能让整次导出失败。
 *
 * ⚠ 向后兼容：`prevText` 缺省 / 空 / 非字符串、且 `context.intent` 为空时，
 *   输出与引入这两个参数前**逐字一致**（旧调用点、旧测试与 `verify-outcome.mjs:470` 依赖它）。
 *
 * @param {string[]} errors `validateOutcome` 给的错误列表（可读中文）
 * @param {string} [prevText] 上一次模型输出的原文（可能被截断过）
 * @param {{ intent?: string, sourceText?: string, format?: "md"|"docx" }} [context]
 *        首次请求的入参；给了 `intent` 才会把完整产出要求重贴一遍
 * @returns {string} 修正用提示词，长度**保证** ≤ `MAX_PROMPT_CHARS`
 */
export function buildRetryPrompt(errors, prevText, context) {
  const list = Array.isArray(errors) && errors.length > 0 ? errors : ["JSON 结构不符合契约"];

  // 有 intent 才插 base：没有 intent 的调用点（旧代码 / 单测）必须保持逐字不变。
  const intent = typeof context?.intent === "string" ? context.intent.trim() : "";
  let sourceText = typeof context?.sourceText === "string" ? context.sourceText : "";
  /**
   * base 用 `let`：越界入参（`sourceText` 远超产品上限）时下面会**先削素材再谈截断**，
   * 因为「保住修正指令」比「保住素材全文」重要 —— 详见兜底那一节。
   */
  let base = intent.length > 0 ? buildOutcomePrompt({ intent, sourceText, format: context?.format }) : "";

  const rawPrev = typeof prevText === "string" ? prevText.trim() : "";
  const hasPrev = rawPrev.length > 0;

  /**
   * 唯一拼装入口 —— 量长度与出成品**必须走同一段代码**。
   * 上一版就是「量的是一套、拼的是另一套」（预留余量没算 errors 列表）才翻的车。
   *
   * @param {string} prevBody 要贴回的上一轮输出（空串 = 不贴）
   * @param {boolean} omitted 上一轮输出因超长被整段丢弃时置 true（只影响文案）
   * @returns {string}
   */
  const assemble = (prevBody, omitted) => {
    /** @type {string[]} */
    const lines = [];
    if (base.length > 0) lines.push(base, "", "===== 修正要求 =====");
    lines.push("你上一次的输出不符合要求，请修正后重新输出。", "");

    if (prevBody.length > 0) {
      lines.push(
        "注意：这是一次独立调用，你看不到上一次的对话，只能依据下面这段输出修正。",
        "",
        "===== 你上一次的输出（可能已截断） =====",
        prevBody,
        "===== 上一次输出结束 =====",
        "",
      );
    } else if (omitted) {
      // 额度被 base 吃光 ⇒ 宁可让模型整篇重写，也不要把请求顶到硬顶之外
      lines.push("注意：这是一次独立调用，你看不到上一次的对话。上一次输出过长，已省略。", "");
    }

    lines.push(
      "发现的问题：",
      ...list.map((e) => `  - ${String(e)}`),
      "",
      "要求：",
      "- 只输出修正后的**完整** JSON（不是片段、不是 diff）。",
      "- 不要 markdown 代码围栏，不要任何解释文字。",
      "- 第一个字符必须是 {，最后一个字符必须是 }。",
    );
    return lines.join("\n");
  };

  // ---- 先量后切 ----
  // 包装开销与 base 无关（只是说明行 + 上下分隔 + 空行），用 1 个字符的探针量差值
  const overhead = assemble("X", false).length - assemble("", false).length - 1;

  /**
   * 按**当前** base 算「prev 能贴多少」并出成品。
   * 抽成闭包是为了让 `base` 被收敛逻辑缩短后，量长度与拼装仍然走同一段代码。
   * @returns {{ prev: string, out: string }}
   */
  const layout = () => {
    const fixed = assemble("", false).length; // base + 修正块 + 完整 errors 列表
    const room = Math.max(0, MAX_PROMPT_CHARS - fixed - overhead);
    let p = rawPrev.slice(0, Math.min(PREV_OUTPUT_MAX_CHARS, room));
    // 只有「被预算截过」且「截完不足最小可用长度」时才整段丢弃，改为明说已省略
    // （见 PREV_OUTPUT_MIN_CHARS）。**原稿本来就这么短的不受影响** —— 那是真原稿，要原样贴回。
    if (p.length < rawPrev.length && p.length < PREV_OUTPUT_MIN_CHARS) p = "";
    return { prev: p, out: assemble(p, hasPrev && p.length === 0) };
  };

  let state = layout();

  // ---- 收敛 1：量准了理论上不超顶；万一超了，先压 prev（多贴几字上一轮输出是奢侈品）----
  if (state.out.length > MAX_PROMPT_CHARS && state.prev.length > 0) {
    // 超出多少就从 prev 尾部切掉多少（多切 1 个字符免得因换行/四舍五入卡住）
    const cut = Math.min(state.prev.length, state.out.length - MAX_PROMPT_CHARS + 1);
    state = { prev: state.prev.slice(0, state.prev.length - cut), out: "" };
    state.out = assemble(state.prev, hasPrev && state.prev.length === 0);
  }
  if (state.out.length > MAX_PROMPT_CHARS && state.prev.length > 0) {
    // 极端情况（固定部分已接近硬顶）：宁可完全不贴上一轮输出
    state = { prev: "", out: assemble("", hasPrev) };
  }

  // ---- 收敛 2：连「不带 prev」都超顶 ⇒ base 自己越界（上游 sourceText 超范围）----
  // 这时**削素材、保指令**：`发现的问题` / `要求：` 是这次重试唯一的有效载荷，
  // 而素材是可再生的（首轮从会话历史再取一次就有）。反过来切尾部会先把
  // 修正指令切光、把素材留满 —— 那次调用必然再错一遍，白烧。
  if (state.out.length > MAX_PROMPT_CHARS && base.length > 0) {
    for (let i = 0; i < 4 && state.out.length > MAX_PROMPT_CHARS && sourceText.length > 0; i += 1) {
      // 按超出量线性削（留 200 字余量），最多四轮 —— 收敛目标是「不超顶」，不值得二分
      sourceText = sourceText.slice(0, Math.max(0, sourceText.length - (state.out.length - MAX_PROMPT_CHARS) - 200));
      base = buildOutcomePrompt({ intent, sourceText, format: context?.format });
      state = layout();
    }
  }

  if (state.out.length > MAX_PROMPT_CHARS) {
    // ---- 最后一道闸：连 intent 都越界（base 无可再削）⇒ 硬切 ----
    // 提示词尾部被切模型仍可能照 base 修正，而超顶会让整次导出直接失败（`INVALID_ARGUMENT`
    // 硬抛、`generate()` 不 catch），两者代价不对等。
    state.out = state.out.slice(0, MAX_PROMPT_CHARS);
  }
  return state.out;
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
