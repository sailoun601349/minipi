/**
 * 产出链路**编排层**：调用 LLM 出 JSON → 校验 → 重试一次 → 渲染（docx 失败则 md）
 * → 落盘 outbox → 推产出卡片事件。
 *
 * ## 这个模块的定位
 *
 * 它是整条链路的「总指挥」，也是**唯一**决定「什么时候降级」的地方。
 * 四个下属模块各司其职、各是纯函数：
 *   · `prompt.js`      —— 组装提示词 + 解析模型 JSON
 *   · `schema.js`      —— 校验 / 归一化 / 生成文件名
 *   · `render-docx.js` —— 出 docx Buffer
 *   · `render-md.js`   —— 出 Markdown 文本
 * 降级决策**全部**集中在这里（方案 §3.3「实现位置」）。
 *
 * ## 依赖注入（为什么 shell / dialog / renderDocx 都是构造参数）
 *
 * `open()` 要调 `shell.openPath`、`saveAs()` 要弹 `dialog.showSaveDialog`——
 * 这两个都来自 `electron`。但本模块要能在**纯 Node** 下被测试（`verify-outcome.mjs`
 * 就是这么跑的，因为本机 Electron GPU 会崩）。所以：
 *   · `shell` / `dialog` **不 import**，而是作为构造参数注入；
 *   · `renderDocxFn` 同样注入 —— 测试要模拟「docx 渲染抛错」这个降级条件，
 *     没有注入口就只能去 monkey-patch 模块，既脏又脆。
 * `src/main/index.js` 负责注入真实的 `electron` 实现。
 *
 * ## 三条降级条件（方案 §3.3，任一命中即降级）
 *
 *   ① JSON 两次都拿不到可渲染 doc → 把模型**自然语言原文**写成 `.md`
 *   ② docx 渲染抛错 → 改出 `.md`
 *   ③ 落盘失败 → **不抛错**，卡片标 `degraded` 且 `absPath:null`，
 *      并把 Markdown 文本塞进 `inlineText`（供渲染层给「复制」按钮）
 *
 * 违反不了的底线：**降级必须对用户可见**（卡片 `degraded:true`），
 * 且**绝不空手而归**（至少 `inlineText` 有内容）。
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  ERROR_CODES,
  LIMITS,
  OUTCOME_ACTIONS,
  OUTCOME_FORMAT,
  OUTCOME_FORMAT_IDS,
  errorMessage,
} from "../../../shared/protocol.js";

import { OUTBOX_DIR } from "../../settings.js";

import { buildFileName, normalizeOutcome, validateOutcome } from "./schema.js";
import { buildOutcomePrompt, buildRetryPrompt, parseOutcomeJson } from "./prompt.js";
import { renderMarkdown } from "./render-md.js";
import { renderDocx } from "./render-docx.js";

/** 素材文本的长度上限 —— 防止把整段超长对话灌进提示词把模型打爆。 */
const SOURCE_TEXT_MAX_CHARS = 8000;

/**
 * 产出链路服务。
 *
 * 状态：一张**内存表** `Map<outcomeId, {absPath, format, inlineText, meta}>`。
 * `open` / `saveAs` / `list` 都查这张表。进程重启后内存表清空（历史上是
 * `list()` 需要扫盘才能恢复 —— 本期未做，见 README「未完成项」）。
 */
export class OutcomeService {
  /**
   * @param {object} deps
   * @param {import("../session.js").PiSessionHost} deps.piHost
   * @param {{info?:Function,warn?:Function,error?:Function}} [deps.logger]
   * @param {(card: object) => void} [deps.emitOutcome] 推产出卡片给渲染层
   * @param {(absPath: string) => Promise<string>} [deps.shellOpener] 真实注入 `shell.openPath`
   * @param {(fileName: string) => Promise<{ canceled: boolean, filePath?: string }>} [deps.dialogOpener]
   *        真实注入 `dialog.showSaveDialog` 的包装
   * @param {string} [deps.outboxDir] 产出目录（缺省 `OUTBOX_DIR`；测试注入临时目录）
   * @param {(doc: object) => Promise<Buffer>} [deps.renderDocxFn] 测试注入口（缺省真实现）
   */
  constructor(deps = {}) {
    this._piHost = deps.piHost;
    this._logger = deps.logger ?? console;
    this._emitOutcome = typeof deps.emitOutcome === "function" ? deps.emitOutcome : () => {};
    this._shellOpener = deps.shellOpener ?? null;
    this._dialogOpener = deps.dialogOpener ?? null;
    this._outboxDir = deps.outboxDir || OUTBOX_DIR;
    /** 注入渲染器：缺省用真的 `renderDocx`。测试用它模拟「docx 渲染抛错」。 */
    this._renderDocx = typeof deps.renderDocxFn === "function" ? deps.renderDocxFn : renderDocx;

    /** @type {Map<string, {absPath: string|null, format: string, inlineText: string|null, meta: object}>} */
    this._outcomes = new Map();
    this._counter = 0;
  }

  /* ==================================================================== *
   * generate —— 主流程
   * ==================================================================== */

  /**
   * 触发一次产出。
   *
   * @param {{ sessionId: string, intent: string, format?: "auto"|"md"|"docx" }} input
   * @returns {Promise<object>} `OutcomeCard`
   * @throws 入参非法 / 产物超限（10MB）时抛 `errorMessage(...)` 形式的 Error
   */
  async generate(input = {}) {
    // ---- 1. 入参校验（每一项都要挡住畸形调用，不给后续流程埋雷）----
    const sessionId = input?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "sessionId 不能为空"));
    }
    const piHost = this._piHost;
    if (!piHost || typeof piHost.hasSession !== "function" || !piHost.hasSession(sessionId)) {
      throw new Error(errorMessage(ERROR_CODES.SESSION_NOT_FOUND, "会话不存在或已释放"));
    }

    const intent = String(input?.intent ?? "").trim();
    if (intent.length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "intent 不能为空"));
    }
    if (intent.length > LIMITS.OUTCOME_INTENT_MAX_CHARS) {
      throw new Error(
        errorMessage(
          ERROR_CODES.INVALID_ARGUMENT,
          `intent 超长（上限 ${LIMITS.OUTCOME_INTENT_MAX_CHARS} 字符，实际 ${intent.length}）`,
        ),
      );
    }

    const rawFormat = input?.format;
    if (rawFormat !== undefined && rawFormat !== null && rawFormat !== "auto" && !OUTCOME_FORMAT_IDS.includes(rawFormat)) {
      throw new Error(
        errorMessage(
          ERROR_CODES.INVALID_ARGUMENT,
          `format 必须是 auto / ${OUTCOME_FORMAT_IDS.join(" / ")} 之一`,
        ),
      );
    }

    // ---- 2. 取素材 ----
    // 简化说明：`session.js` 目前**没有**「导出近期会话文本」的现成方法。
    // 方案 §3.1.1 也提醒「不要为了取素材去大改 session.js」⇒ 这里把素材简化成
    // 只有 `intent` 本身（模型会依据 intent + 自己的上下文来组织）。若将来
    // session.js 提供 `recentTranscript()`，把它接在下面这个常量处即可。
    const sourceText = this._collectSourceText(sessionId);

    // ---- 3. 调一次模型出 JSON ----
    let text = await this._callStructured(sessionId, buildOutcomePrompt({ intent, sourceText, format: rawFormat }));

    // ---- 4. 解析 + 校验；失败则用修正提示词再试一次（降级条件①的第一次修正）----
    let doc = null;
    const parsed = parseOutcomeJson(text);
    if (!parsed.ok) {
      this._logger.warn?.(`[minipi:outcome] 首次 JSON 解析失败，发起修正重试`);
      text = await this._callStructured(sessionId, buildRetryPrompt(parsed.errors));
      doc = this._extractDoc(text);
    } else {
      doc = this._extractDoc(text);
      if (!doc) {
        // schema 校验失败 → 修正重试一次
        const firstErrors = this._lastValidateErrors;
        this._logger.warn?.(`[minipi:outcome] 首次 schema 校验失败，发起修正重试`);
        text = await this._callStructured(sessionId, buildRetryPrompt(firstErrors));
        doc = this._extractDoc(text);
      }
    }

    // ---- 5. 仍拿不到可渲染 doc → 降级①：把模型自然语言原文写成 md ----
    let degraded = false;
    let inlineMarkdown;
    if (doc) {
      inlineMarkdown = renderMarkdown(doc);
    } else {
      degraded = true;
      const fallbackTitle = intent.slice(0, 40) || "产出";
      inlineMarkdown = this._plainTextToMarkdown(fallbackTitle, text);
      // 用一个最小的 doc 占位（title + 原文），让后续渲染走 md 路径。
      doc = { title: fallbackTitle, sections: [{ heading: fallbackTitle, bullets: [] }] };
    }

    // ---- 6. 决定目标格式 ----
    // auto 优先 docx（本期只有 md/docx 两种）。显式 md 直接走 md；降级①已强制 md。
    let format = rawFormat === OUTCOME_FORMAT.MD ? OUTCOME_FORMAT.MD : OUTCOME_FORMAT.DOCX;
    if (degraded) format = OUTCOME_FORMAT.MD;

    // ---- 7. 渲染 ----
    /** @type {Buffer} */
    let buffer;
    if (format === OUTCOME_FORMAT.DOCX) {
      try {
        buffer = await this._renderDocx(doc);
      } catch (err) {
        // 降级②：docx 渲染抛错 → 改出 md
        this._logger.warn?.(`[minipi:outcome] docx 渲染失败，降级为 Markdown：${this._safeErr(err)}`);
        degraded = true;
        format = OUTCOME_FORMAT.MD;
        inlineMarkdown = renderMarkdown(doc);
        buffer = Buffer.from(inlineMarkdown, "utf8");
      }
    } else {
      buffer = Buffer.from(inlineMarkdown, "utf8");
    }

    // ---- 12. 超限检查（放在落盘前，避免先写一个 10MB+ 的怪文件）----
    if (buffer.length > LIMITS.OUTCOME_FILE_MAX_BYTES) {
      throw new Error(
        errorMessage(
          ERROR_CODES.OUTCOME_WRITE_FAILED,
          `产出物超过大小上限（${LIMITS.OUTCOME_FILE_MAX_BYTES} 字节）`,
        ),
      );
    }

    // ---- 8. 落盘（同名不覆盖；失败走降级③）----
    const fileName = buildFileName(doc.title ?? intent, format);
    const outcomeId = `o_${(this._counter += 1)}`;
    const createdAt = Date.now();

    /** @type {string | null} */
    let absPath = null;
    try {
      absPath = await this._writeOutbox(fileName, buffer);
    } catch (err) {
      // 降级③：落盘失败 → **不抛错**，卡片标 degraded + absPath:null + inlineText
      this._logger.warn?.(`[minipi:outcome] 落盘失败，降级为仅返回文本：${this._safeErr(err)}`);
      degraded = true;
      absPath = null;
    }

    // ---- 9. 造卡片（字段严格照 protocol.js）----
    const card = {
      outcomeId,
      sessionId,
      format,
      degraded,
      fileName: absPath ? path.basename(absPath) : fileName,
      bytes: buffer.length,
      title: String(doc.title ?? "").slice(0, LIMITS.OUTCOME_TITLE_MAX_CHARS),
      createdAt,
      actions: [...OUTCOME_ACTIONS],
      // 仅在「无落盘文件」时提供 inlineText（供渲染层给「复制」按钮）。
      // 有文件时不塞，避免卡片载荷变大。
      ...(absPath === null ? { inlineText: inlineMarkdown } : {}),
    };

    // ---- 10. 登记内存表 ----
    this._outcomes.set(outcomeId, {
      absPath,
      format,
      inlineText: inlineMarkdown,
      meta: card,
    });

    // ---- 11. 推卡片 ----
    try {
      this._emitOutcome(card);
    } catch (err) {
      this._logger.warn?.(`[minipi:outcome] 推卡片失败：${this._safeErr(err)}`);
    }

    return card;
  }

  /* ==================================================================== *
   * open / saveAs / list
   * ==================================================================== */

  /**
   * 打开产出物（系统默认程序）。
   * @param {{ outcomeId: string }} input
   * @returns {Promise<{ ok: boolean }>}
   * @throws 查不到 id → `OUTCOME_NOT_FOUND`
   */
  async open(input = {}) {
    const entry = this._requireOutcome(input?.outcomeId);
    if (!entry.absPath) {
      // 降级③的产物没有文件可打开（但内容在 inlineText 里）
      throw new Error(errorMessage(ERROR_CODES.OUTCOME_NOT_FOUND, "产出物没有落盘文件，无法打开（可复制文本）"));
    }
    if (typeof this._shellOpener !== "function") {
      throw new Error(errorMessage(ERROR_CODES.INTERNAL, "未注入 openPath 实现"));
    }
    let result = "";
    try {
      result = await this._shellOpener(entry.absPath);
    } catch (err) {
      throw new Error(errorMessage(ERROR_CODES.OUTCOME_NOT_FOUND, `打开失败：${this._safeErr(err)}`));
    }
    // `shell.openPath` 成功返回空串，失败返回错误说明。
    // 空串 / 空值都视为成功；非空字符串视为失败（把它当可读信息透传，已 sanitize）。
    if (typeof result === "string" && result.length > 0) {
      throw new Error(errorMessage(ERROR_CODES.OUTCOME_NOT_FOUND, `打开失败：${this._safeErr(result)}`));
    }
    return { ok: true };
  }

  /**
   * 另存为（弹系统对话框）。
   * @param {{ outcomeId: string }} input
   * @returns {Promise<{ savedPath: string|null, canceled: boolean }>}
   */
  async saveAs(input = {}) {
    const entry = this._requireOutcome(input?.outcomeId);
    if (!entry.absPath) {
      throw new Error(errorMessage(ERROR_CODES.OUTCOME_NOT_FOUND, "产出物没有落盘文件，无法另存"));
    }
    if (typeof this._dialogOpener !== "function") {
      throw new Error(errorMessage(ERROR_CODES.INTERNAL, "未注入 showSaveDialog 实现"));
    }

    const defaultName = path.basename(entry.absPath);
    const picked = await this._dialogOpener(defaultName);
    if (!picked || picked.canceled || !picked.filePath) {
      return { savedPath: null, canceled: true };
    }
    try {
      await fs.copyFile(entry.absPath, picked.filePath);
    } catch (err) {
      throw new Error(errorMessage(ERROR_CODES.OUTCOME_WRITE_FAILED, `另存失败：${this._safeErr(err)}`));
    }
    return { savedPath: picked.filePath, canceled: false };
  }

  /**
   * 列出历史产出（内存表；按创建时间倒序）。
   * @param {{ limit?: number }} [input]
   * @returns {{ items: object[] }}
   */
  list(input = {}) {
    let limit = Number.isFinite(input?.limit) ? Math.floor(input.limit) : 20;
    // 分页边界：limit 下界 1、上界 100（挡住 0 / 负数 / 99999）
    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;

    const items = [...this._outcomes.values()]
      .map((e) => e.meta)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    return { items };
  }

  /** 供测试/内部使用：暴露内存表条目（只读拷贝）。 */
  getOutcomeEntry(outcomeId) {
    return this._outcomes.get(outcomeId) ?? null;
  }

  /* ==================================================================== *
   * 内部
   * ==================================================================== */

  /**
   * 从 Pi 会话取素材文本。
   *
   * 当前实现：**简化**为只返回空串（模型依据 intent 与自身上下文组织）。
   * 原因见 `generate()` 第 2 步的注释。保留成方法是为了将来接 session.js
   * 的 `recentTranscript()` 时只改这一处。
   * @param {string} _sessionId
   * @returns {string}
   */
  _collectSourceText(_sessionId) {
    return "";
  }

  /**
   * 调 `piHost.generateStructured` 拿一次文本。
   * @param {string} sessionId
   * @param {string} instruction
   * @returns {Promise<string>}
   */
  async _callStructured(sessionId, instruction) {
    const piHost = this._piHost;
    if (!piHost || typeof piHost.generateStructured !== "function") {
      throw new Error(errorMessage(ERROR_CODES.INTERNAL, "Pi 宿主不支持结构化输出"));
    }
    const res = await piHost.generateStructured({ sessionId, instruction });
    return typeof res?.text === "string" ? res.text : "";
  }

  /**
   * 解析一段模型文本 → 可渲染的 doc（先标准校验，失败再宽容抢救）。
   * 顺便把最后一次校验错误记到 `_lastValidateErrors`，供修正提示词使用。
   * @param {string} text
   * @returns {import("./schema.js").OutcomeDoc | null}
   */
  _extractDoc(text) {
    const parsed = parseOutcomeJson(text);
    if (!parsed.ok) {
      this._lastValidateErrors = parsed.errors;
      return null;
    }
    const validated = validateOutcome(parsed.value);
    if (validated.ok) {
      this._lastValidateErrors = [];
      return validated.doc;
    }
    this._lastValidateErrors = validated.errors;
    // 宽容抢救：validateOutcome 失败但结构还有救 → 用 normalizeOutcome
    return normalizeOutcome(parsed.value);
  }

  /**
   * 降级①的文本形态：把模型的自然语言原文包成一段 Markdown。
   * 标题用 intent 前 40 字（这是用户能认出来的东西，比「未命名」强）。
   * @param {string} title
   * @param {string} rawText
   * @returns {string}
   */
  _plainTextToMarkdown(title, rawText) {
    const body = String(rawText ?? "").trim() || "（模型未返回内容）";
    return `# ${title}\n\n> 本次未能整理成结构化格式，以下是模型的原始回答：\n\n${body}\n`;
  }

  /**
   * 写 outbox。**同名不覆盖**：已存在 `x.docx` 时改为 `x-2.docx` / `x-3.docx`…
   *
   * 为什么不覆盖：产出物是**用户资产**。同一天连着做两份「周报」很常见，
   * 静默覆盖会丢用户的东西——宁可多一个 `-2`，也不删旧文件。
   *
   * 用 `wx` 标志（O_EXCL）做「存在即失败」，靠文件系统保证原子性，
   * 避免「先 exists 再 write」之间被并发插入（TOCTOU）。
   *
   * @param {string} fileName 期望文件名
   * @param {Buffer} buffer
   * @returns {Promise<string>} 实际落盘的绝对路径
   * @throws 全部后缀都占满 / outbox 不可写 → 抛错（由调用方降级③）
   */
  async _writeOutbox(fileName, buffer) {
    const dir = this._outboxDir;
    await fs.mkdir(dir, { recursive: true });

    const ext = path.extname(fileName);
    const stem = path.basename(fileName, ext);

    for (let i = 0; i < 1000; i += 1) {
      const candidate = i === 0 ? `${stem}${ext}` : `${stem}-${i + 1}${ext}`;
      const abs = path.join(dir, candidate);
      try {
        // wx = 独占创建，已存在则抛 EEXIST
        await fs.writeFile(abs, buffer, { flag: "wx" });
        return abs;
      } catch (err) {
        if (err && err.code === "EEXIST") continue; // 名字被占，换下一个后缀
        throw err; // 其它错误（权限、磁盘满…）→ 交给调用方降级③
      }
    }
    throw new Error("同名产出物过多，无法生成唯一文件名");
  }

  /**
   * 取内存表条目，查不到抛可读错误。
   * @param {unknown} outcomeId
   */
  _requireOutcome(outcomeId) {
    if (typeof outcomeId !== "string" || outcomeId.length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "outcomeId 不能为空"));
    }
    const entry = this._outcomes.get(outcomeId);
    if (!entry) {
      // 文案对用户友好，且**不**泄露任何路径
      throw new Error(errorMessage(ERROR_CODES.OUTCOME_NOT_FOUND, "产出物不存在或已被移动"));
    }
    return entry;
  }

  /**
   * 错误信息脱敏：去换行、截断、**不带堆栈**。
   * 错误不能包含数据库语句 / 文件路径 / 密钥 / 完整手机号（角色守则要求）。
   * @param {unknown} err
   * @returns {string}
   */
  _safeErr(err) {
    let s = err instanceof Error ? err.message : String(err ?? "");
    s = s.replace(/\r?\n/g, " ").trim();
    if (s.length > 200) s = `${s.slice(0, 200)}…`;
    return s || "未知错误";
  }
}

export { OUTCOME_FORMAT, OUTCOME_FORMAT_IDS };
