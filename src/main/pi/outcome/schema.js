/**
 * `OutcomeDoc` 的形状定义 + 校验 + 归一化 + 文件名生成。
 *
 * ## 这个模块存在的理由
 *
 * minipi 的产出铁律：**模型只出结构化 JSON，代码用 `docx` 库落盘**。
 * 模型绝不能直接生成 docx/xlsx（docx 是 ZIP 容器，逐字节写必坏）。
 * 所以模型输出必须经过这里「定形」——把不稳定的自然语言/半结构化 JSON
 * 收敛成一个**字段固定的 `OutcomeDoc`**，下游 `render-docx.js` / `render-md.js`
 * 只认这个形状，不再关心模型怎么给。
 *
 * ## 三条设计原则（决定代码为什么长这样）
 *
 *   1. **零依赖纯函数**：只 import `node:path`（生成文件名要用到扩展名处理）。
 *      不 import electron、不 import `docx`、不 import Pi SDK ⇒ 可以在纯 Node 下单测。
 *   2. **宽容优先（刻意）**：模型的输出格式会漂（今天给 `bullets`，明天给 `items`，
 *      后天给 `content` 字符串）。校验器**能用就用**，能归一化就归一化——
 *      每多一次「严校验失败」，就多一次降级为 Markdown，用户体验就掉一档。
 *      所以 `validateOutcome` 里的「宽容路径」不是妥协，是**明确的产品取向**。
 *   3. **截断而非报错**：单条 bullet 超长、sections 超多——这些是「模型话多」，
 *      不是「模型说错」。截断即可（保留内容主体），不要因此判定整份产出失败。
 *
 * 方案出处：`docs/minipi-v0.4-impl-plan.md` §3.1 / §3.4。
 */

/* 本模块**零 import**：文件名清洗用纯字符串处理（不需要 node:path），
 * 这样它完全没有外部依赖，可以在任何环境下被单测。 */

/**
 * @typedef {object} OutcomeSection
 * @property {string} heading   节标题（必填，非空）
 * @property {string[]} bullets 该节下的条目（可能为空数组——模型给了空节也接受）
 */

/**
 * 结构化产出的形状（协议冻结，渲染层与渲染器都认这个）。
 *
 * @typedef {object} OutcomeDoc
 * @property {string} title           必填，非空，≤ LIMITS.OUTCOME_TITLE_MAX_CHARS(120)
 * @property {string[]} [subtitle]    可选，副标题行（每行一条）
 * @property {OutcomeSection[]} sections 必填，1..LIMITS.OUTCOME_SECTIONS_MAX(50)
 */

/* ========================================================================== *
 * 常量（与 protocol.js 的 LIMITS 保持同值；这里**故意不 import protocol.js**，
 * 因为本模块要求「零业务依赖」，而 protocol.js 虽是纯常量但属于共享契约层；
 * 内联常量避免 outcome 目录反向依赖 shared 层，便于将来单独抽包。）
 * ========================================================================== */

/** 标题长度上限（与 LIMITS.OUTCOME_TITLE_MAX_CHARS 一致）。 */
const TITLE_MAX_CHARS = 120;
/** 节数上限（与 LIMITS.OUTCOME_SECTIONS_MAX 一致）。 */
const SECTIONS_MAX = 50;
/** 单条 bullet 长度上限（与 LIMITS.OUTCOME_BULLET_MAX_CHARS 一致）。 */
const BULLET_MAX_CHARS = 2000;

/** 空标题兜底（既用于校验失败后的文件名，也用于 `normalizeOutcome` 抢救）。 */
const FALLBACK_TITLE = "未命名";

/* ========================================================================== *
 * 小工具
 * ========================================================================== */

/**
 * 是不是「普通对象」。
 * 这里**不复用 protocol.js 的 `isPlainObject`**（见文件头「零业务依赖」说明），
 * 自己写一份等价的 4 行判断，逻辑简单到不会漂。
 * @param {unknown} v
 * @returns {boolean}
 */
function isPlainObject(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * 标题归一化：把连续空白（含全角空格）压成单个半角空格，并去首尾。
 *
 * 为什么要压：模型经常在标题里塞 `\n` 或多余空格（`"周  报"` / `"周报\n"`），
 * 直接拿去当文件名会得到带换行的怪名字，且渲染卡片时会把标题撑成两行。
 *
 * @param {unknown} v
 * @returns {string}
 */
function normalizeTitle(v) {
  return String(v ?? "")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

/**
 * 把一条 bullet 归一化：转字符串 → 压掉首尾空白 → 超长则截断。
 *
 * 截断而不是报错：模型偶尔会把整段材料塞进一条 bullet，这是「话多」不是「说错」，
 * 截掉尾巴比让整份产出降级划算（方案 §3.3 的降级越少越好）。
 *
 * @param {unknown} v
 * @returns {string} 可能为空串（调用方负责过滤空串）
 */
function normalizeBullet(v) {
  const s = String(v ?? "").trim();
  return s.length > BULLET_MAX_CHARS ? s.slice(0, BULLET_MAX_CHARS) : s;
}

/**
 * 把模型可能的「一段文本」拆成 bullets 数组。
 *
 * 模型给的字段五花八门，我们见过的三种形态都要吃下：
 *   · `bullets: string[]`       —— 标准形态，直接用
 *   · `items: string[]`         —— 别名（部分模型爱用 items）
 *   · `content: string` / `text: string` —— 一段文本，按换行 / 中文分号 / 英文分号切
 *
 * 这是「宽容优先」原则的落点：**只要模型把内容给出来了，我们就尽量接住**。
 *
 * @param {unknown} section 一个 section 原始对象
 * @returns {string[]} 归一化后的 bullets（已 trim / 过滤空串 / 截断）
 */
function coerceBullets(section) {
  if (!isPlainObject(section)) return [];

  // ① 标准字段 bullets
  if (Array.isArray(section.bullets)) {
    return section.bullets.map(normalizeBullet).filter((s) => s.length > 0);
  }
  // ② 别名 items
  if (Array.isArray(section.items)) {
    return section.items.map(normalizeBullet).filter((s) => s.length > 0);
  }
  // ③ content / text 字符串 → 按换行或分号切分
  for (const key of ["content", "text", "body"]) {
    const raw = section[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw
        .split(/\r?\n|[;；]/)
        .map(normalizeBullet)
        .filter((s) => s.length > 0);
    }
  }
  // 都没有 → 空节（接受，不报错）
  return [];
}

/**
 * 校验并归一化一份「结构化产出」。
 *
 * **注意它与 `normalizeOutcome` 的分工**：
 *   · `validateOutcome` —— 走「标准路径」，判 OK / 不 OK，同时给出归一化后的 doc。
 *     它在**必填字段缺失**时返回 `ok:false`（比如没有 title、没有任何 section），
 *     但它**不是严苛的**——凡是能宽容的（别名、超长、截断）都在这里宽容掉。
 *   · `normalizeOutcome` —— 走「抢救路径」，`validateOutcome` 挂了之后再试一把，
 *     专治「顶层字段全错位」这类更离谱的形态。
 *
 * @param {unknown} value 待校验的值（模型 parse 出来的原始对象）
 * @returns {{ ok: boolean, errors: string[], doc: OutcomeDoc | null }}
 *          `ok:false` 时 `doc` 恒为 `null`（不返回半成品，避免调用方误用）
 */
export function validateOutcome(value) {
  /** @type {string[]} */
  const errors = [];

  if (!isPlainObject(value)) {
    return { ok: false, errors: ["产出不是一个对象"], doc: null };
  }

  // ---- title：必填、非空 ----
  const title = normalizeTitle(value.title);
  if (title.length === 0) {
    errors.push("title 不能为空");
  }
  const safeTitle = title.length > TITLE_MAX_CHARS ? title.slice(0, TITLE_MAX_CHARS) : title;

  // ---- subtitle：可选，接受 string 或 string[] ----
  /** @type {string[]} */
  let subtitle = [];
  if (typeof value.subtitle === "string") {
    subtitle = value.subtitle
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } else if (Array.isArray(value.subtitle)) {
    subtitle = value.subtitle.map(normalizeBullet).filter((s) => s.length > 0);
  }

  // ---- sections：必填，1..SECTIONS_MAX ----
  let rawSections = value.sections;
  // 宽容：顶层直接给了 bullets / items（没有 sections 包装）——包一层
  if (!Array.isArray(rawSections) && (Array.isArray(value.bullets) || Array.isArray(value.items))) {
    rawSections = [{ heading: safeTitle || FALLBACK_TITLE, bullets: value.bullets ?? value.items }];
  }
  if (!Array.isArray(rawSections)) {
    return { ok: false, errors: [...errors, "sections 必须是数组"], doc: null };
  }

  /** @type {OutcomeSection[]} */
  const sections = [];
  for (let i = 0; i < rawSections.length && sections.length < SECTIONS_MAX; i += 1) {
    const raw = rawSections[i];
    if (!isPlainObject(raw)) {
      errors.push(`sections 第 ${i + 1} 项不是对象`);
      continue;
    }
    const heading = normalizeTitle(raw.heading ?? raw.title ?? raw.name);
    // 宽容：bullets 不是数组时，若给了 items/content 也能救活（coerceBullets 处理）
    if (
      raw.bullets !== undefined &&
      !Array.isArray(raw.bullets) &&
      raw.items === undefined &&
      raw.content === undefined &&
      raw.text === undefined
    ) {
      errors.push(`sections 第 ${i + 1} 项的 bullets 不是数组`);
      // 仍然继续：给它一个空 bullets，避免整个 section 丢失
    }
    const bullets = coerceBullets(raw);
    // heading 为空但有 bullets：用「节 N」占位，好过丢掉内容
    sections.push({
      heading: heading.length > 0 ? heading : `节 ${sections.length + 1}`,
      bullets,
    });
  }

  if (sections.length === 0) {
    errors.push("sections 至少要有一节");
  }

  if (errors.length > 0) {
    return { ok: false, errors, doc: null };
  }

  /** @type {OutcomeDoc} */
  const doc = { title: safeTitle, sections };
  if (subtitle.length > 0) doc.subtitle = subtitle;
  return { ok: true, errors: [], doc };
}

/**
 * 「抢救」：`validateOutcome` 失败后的**最后一道**归一化。
 *
 * 什么时候用：模型这次输出连标准路径都过不了（比如 title 缺失、sections 缺失
 * 但顶层有 bullets、或者整个结构错位）。这时**不要立刻降级**，先在这里尽最大努力
 * 拼出一个能渲染的 doc —— 因为降级一次，用户感受到的就是「这次没做好」。
 *
 * 相比 `validateOutcome` 更宽松的几点：
 *   · title 缺失 → 用 `"未命名"`（而不是报错）
 *   · sections 缺失但有顶层 bullets / content → 包一层
 * 但**依然不无中生有**：如果连一点内容都捞不出来（比如整个空对象），返回 `null`，
 * 交给编排层走「降级①：把模型原文写成 md」。
 *
 * @param {unknown} raw
 * @returns {OutcomeDoc | null} 能渲染的 doc；实在救不回返回 null
 */
export function normalizeOutcome(raw) {
  if (!isPlainObject(raw)) return null;

  // 先试标准路径（可能本身就 ok，只是调用方想兜底）
  const strict = validateOutcome(raw);
  if (strict.ok) return strict.doc;

  // ---- 抢救 title ----
  const title = normalizeTitle(raw.title) || FALLBACK_TITLE;

  /** @type {string[]} */
  let subtitle = [];
  if (typeof raw.subtitle === "string") {
    subtitle = raw.subtitle.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(raw.subtitle)) {
    subtitle = raw.subtitle.map(normalizeBullet).filter(Boolean);
  }

  // ---- 抢救 sections ----
  /** @type {OutcomeSection[]} */
  let sections = [];

  if (Array.isArray(raw.sections)) {
    for (const s of raw.sections.slice(0, SECTIONS_MAX)) {
      if (!isPlainObject(s)) continue;
      const heading = normalizeTitle(s.heading ?? s.title ?? s.name) || `节 ${sections.length + 1}`;
      sections.push({ heading, bullets: coerceBullets(s) });
    }
  }

  // 顶层直接给内容（没有 sections 包装）——包一层
  if (sections.length === 0) {
    const topLevel = coerceBullets(raw);
    if (topLevel.length > 0) {
      sections.push({ heading: title, bullets: topLevel });
    }
  }

  // 连一节都凑不出来 → 放弃（交给编排层降级为「模型原文 md」）
  if (sections.length === 0) return null;

  /** @type {OutcomeDoc} */
  const doc = { title: title.slice(0, TITLE_MAX_CHARS), sections };
  if (subtitle.length > 0) doc.subtitle = subtitle;
  return doc;
}

/**
 * 生成产出文件名。**纯函数，前后端共用同一份规则**。
 *
 * 规则（方案 §3.4 钉死，两侧不能各写一套）：
 *   1. 去 Windows 非法字符 `\ / : * ? " < > |` 与控制字符 → 替换为 `-`
 *   2. 连续 `-` 压成一个
 *   3. 去首尾 `-` 和空格
 *   4. 截到 `TITLE_MAX_CHARS`
 *   5. 空标题兜底 `"未命名"`
 *   6. 拼 `-YYYY-MM-DD`（**本地时间**，不是 UTC）
 *   7. 加扩展名（`format === "docx" ? ".docx" : ".md"`）
 *
 * 例：`buildFileName("周报", "docx", new Date(2026, 8, 23))` → `"周报-2026-09-23.docx"`。
 *
 * 为什么日期用**本地时间**：用户看到的是自己的日期。用 UTC 会出现「凌晨 8 点前
 * 生成的文件日期是昨天」这种诡异体验（东八区）。
 *
 * @param {unknown} title 原始标题
 * @param {"md" | "docx"} format 目标格式
 * @param {Date} [date] 日期（缺省当前时间）；测试可传入固定日期
 * @returns {string} 安全文件名（不含目录）
 */
export function buildFileName(title, format, date) {
  const d = date instanceof Date ? date : new Date();

  // 1 + 2 + 3：清洗非法字符
  let base = String(title ?? "")
    // Windows 保留字符（`\ / : * ? " < > |`）与控制字符（\u0000-\u001f）→ `-`
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    // 连续 `-` 压成一个
    .replace(/-{2,}/g, "-")
    // 首尾的 `-` 和空白都去掉
    .replace(/^[-\s]+/, "")
    .replace(/[-\s]+$/, "")
    .trim();

  // 4：截断
  if (base.length > TITLE_MAX_CHARS) base = base.slice(0, TITLE_MAX_CHARS);

  // 5：空标题兜底
  if (base.length === 0) base = FALLBACK_TITLE;

  // 6：拼日期（本地时间；月/日补零）
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  // 7：扩展名
  const ext = format === "docx" ? ".docx" : ".md";

  return `${base}-${y}-${m}-${day}${ext}`;
}

/** 导出常量便于测试与调用方复用（避免各处再硬编码一遍）。 */
export const SCHEMA_LIMITS = Object.freeze({
  TITLE_MAX_CHARS,
  SECTIONS_MAX,
  BULLET_MAX_CHARS,
  FALLBACK_TITLE,
});
