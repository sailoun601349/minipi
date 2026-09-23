/**
 * `OutcomeDoc` → Markdown 文本。**降级兜底格式，必须永远可用、绝不抛错**。
 *
 * ## 为什么把 Markdown 当「兜底」
 *
 * docx 渲染可能失败（库异常、Buffer 生成失败、依赖缺失）；落盘也可能失败。
 * 这时如果什么都不给用户，就是「空手而归」——M5 验收明确要求
 * 「模型报错时降级仍要有东西交出去」。Markdown 是最低成本的兜底：
 * 纯文本、零依赖、任何编辑器都能打开，而且用户可以直接复制粘贴。
 *
 * ## 为什么绝不抛错
 *
 * 本函数被调用时，链路**已经**处在降级状态（docx 挂了或写盘挂了）。
 * 如果它自己也抛，降级链就断了，用户彻底拿不到东西。
 * 所以这里对任何异常输入都必须返回一段可读文本，而不是错误。
 *
 * 零依赖，纯函数。
 *
 * 方案出处：`docs/minipi-v0.4-impl-plan.md` §3.1 / §3.3。
 */

/** 兜底文案（doc 为空时返回，而不是空串——空文件对用户毫无意义）。 */
const EMPTY_TEXT = "（无内容）";

/**
 * 把一份 `OutcomeDoc` 渲染成 Markdown。
 *
 * 输出形态：
 *   ```markdown
 *   # 标题
 *
 *   _副标题1_
 *   _副标题2_
 *
 *   ## 第一节
 *
 *   - 条目一
 *   - 条目二
 *   ```
 *
 * @param {import("./schema.js").OutcomeDoc | null | undefined} doc
 * @returns {string} Markdown 文本；`doc` 为空时返回 `"（无内容）"`（**不抛错**）
 */
export function renderMarkdown(doc) {
  // doc 为空 / 根本不是对象 → 兜底文案。不抛错（见文件头说明）。
  if (!doc || typeof doc !== "object") return EMPTY_TEXT;

  try {
    const lines = [];

    const title = String(doc.title ?? "").trim();
    lines.push(`# ${title.length > 0 ? title : "未命名"}`);

    // 副标题：斜体行，每条一行
    if (Array.isArray(doc.subtitle)) {
      for (const s of doc.subtitle) {
        const t = String(s ?? "").trim();
        if (t.length > 0) lines.push(`_${t}_`);
      }
    }

    const sections = Array.isArray(doc.sections) ? doc.sections : [];
    for (const section of sections) {
      if (!section || typeof section !== "object") continue;
      lines.push(""); // 节之间空一行，Markdown 才有正确间距
      const heading = String(section.heading ?? "").trim();
      lines.push(`## ${heading.length > 0 ? heading : "（无标题）"}`);

      const bullets = Array.isArray(section.bullets) ? section.bullets : [];
      for (const bullet of bullets) {
        lines.push(`- ${indentBullet(String(bullet ?? ""))}`);
      }
    }

    // 末尾补一个换行：文件以换行结束是 POSIX 惯例，也便于追加。
    return `${lines.join("\n")}\n`;
  } catch {
    // 走到这里说明 doc 诡异到连遍历都炸了。降级链不能断——返回兜底文案。
    return EMPTY_TEXT;
  }
}

/**
 * bullet 内部含换行时，把续行正确缩进（Markdown 列表续行规则）。
 *
 * 为什么需要：Markdown 里
 *   ```
 *   - 第一行
 *   第二行
 *   ```
 * 会把「第二行」当成一个新的普通段落，脱离列表项。正确写法是续行缩进 2 空格：
 *   ```
 *   - 第一行
 *     第二行
 *   ```
 *
 * @param {string} text
 * @returns {string} 已处理续行缩进的文本
 */
function indentBullet(text) {
  if (!text.includes("\n")) return text;
  const [first, ...rest] = text.split(/\r?\n/);
  return [first, ...rest.map((line) => `  ${line}`)].join("\n");
}
