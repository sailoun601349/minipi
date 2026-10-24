/**
 * 产出索引（D-14）：让「导出过的文件」在重启后依然找得到。
 *
 * 为什么需要它：`OutcomeService.list()` 原来读的是**内存 Map**，App 一关就空。
 * 用户导出的是一堆真文件，但产品里没有任何地方能再看它们一眼 ——
 * 这正是「产出后没人找得到」这个硬伤的根。
 *
 * 设计口径（对齐 B1 计划 §B-1/B-2/B-3）：
 *   · **索引与文件分离**：索引写 `~/.minipi/outcomes.json`，文件仍在 outbox；
 *   · **启动对账**：索引有文件无 → 删条目；文件有索引无 → 补条目（幂等）；
 *   · **只存文件名不存绝对路径**：打开时再拼 outbox，防索引被改后指向仓外；
 *   · **原子写 + 坏文件兜底**：写 tmp 再 rename；解析失败改名 `.bad` 后重建。
 *
 * 本模块不 import electron / 不 import Pi SDK，可纯 Node 测。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { OUTBOX_DIR, MINIPI_HOME } from "../../settings.js";

/** 允许进索引的扩展名（与 OUTCOME_FORMAT 对齐）。 */
const ALLOWED_EXT = Object.freeze([".md", ".docx"]);

/** 从文件名反推标题：`周报-2026-10-21.md` → `周报`。 */
export function titleFromFileName(fileName) {
  const stem = path.basename(String(fileName ?? ""), path.extname(String(fileName ?? "")));
  return stem.replace(/-\d{4}-\d{2}-\d{2}$/, "").trim();
}

/** 从扩展名判格式；不认识返回 null。 */
export function formatFromFileName(fileName) {
  const ext = path.extname(String(fileName ?? "")).toLowerCase();
  return ext === ".md" ? "md" : ext === ".docx" ? "docx" : null;
}

/** 索引条目归一（防手改索引塞进危险字段）。 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fileName = typeof raw.fileName === "string" ? path.basename(raw.fileName) : "";
  if (!fileName) return null;
  const format = formatFromFileName(fileName);
  if (!format) return null;
  return {
    id: fileName,
    fileName,
    format,
    title: String(raw.title ?? titleFromFileName(fileName)).slice(0, 120),
    bytes: Number.isFinite(raw.bytes) ? Math.max(0, Math.floor(raw.bytes)) : 0,
    createdAt: Number.isFinite(raw.createdAt) ? Math.floor(raw.createdAt) : 0,
    pinned: raw.pinned === true,
  };
}

export class OutcomeStore {
  /**
   * @param {object} [deps]
   * @param {string} [deps.outboxDir] 产出目录（测试注入临时目录）
   * @param {string} [deps.indexPath] 索引文件路径（测试注入临时文件）
   * @param {string} [deps.trashDir]  删除去向（测试注入）
   * @param {{warn?:Function}} [deps.logger]
   */
  constructor(deps = {}) {
    this._outboxDir = deps.outboxDir || OUTBOX_DIR;
    this._indexPath = deps.indexPath || path.join(MINIPI_HOME, "outcomes.json");
    this._trashDir = deps.trashDir || path.join(MINIPI_HOME, ".trash");
    this._logger = deps.logger ?? console;
    /** @type {Map<string, object>} id(=fileName) → entry */
    this._entries = new Map();
    this._loaded = false;
  }

  get outboxDir() {
    return this._outboxDir;
  }

  /** 索引里登记的条目（未加载时先 load）。 */
  entries() {
    if (!this._loaded) this.load();
    return [...this._entries.values()];
  }

  /**
   * 读索引 + 与 outbox 对账。**幂等**，可反复调用（启动时一次）。
   * @returns {{ items: number, added: number, dropped: number, repaired: boolean }}
   */
  load() {
    let repaired = false;
    let raw = [];
    try {
      const text = fs.readFileSync(this._indexPath, "utf8");
      const doc = JSON.parse(text);
      raw = Array.isArray(doc?.items) ? doc.items : [];
    } catch (err) {
      if (err?.code !== "ENOENT") {
        // 坏索引：改名保留现场，再重建（不静默丢用户数据）
        repaired = true;
        try {
          fs.renameSync(this._indexPath, `${this._indexPath}.bad-${Date.now()}`);
        } catch {
          /* 改名失败也不该拖垮启动 */
        }
        this._logger.warn?.(`[minipi:outcome] 索引损坏，已重建：${err?.message ?? err}`);
      }
    }

    this._entries.clear();
    for (const item of raw) {
      const entry = normalizeEntry(item);
      if (entry) this._entries.set(entry.id, entry);
    }
    this._loaded = true;

    const { added, dropped } = this._reconcile();
    if (added || dropped) this.save();
    return { items: this._entries.size, added, dropped, repaired };
  }

  /**
   * 与磁盘对账：
   *   · 索引有、文件无 ⇒ 删条目（用户手动删了文件，索引不能继续指向幽灵）
   *   · 文件有、索引无 ⇒ 补条目（用户手动放进来的也算，标题从文件名反推）
   */
  _reconcile() {
    let added = 0;
    let dropped = 0;

    /** @type {Map<string, fs.Stats>} */
    const onDisk = new Map();
    try {
      for (const name of fs.readdirSync(this._outboxDir)) {
        const ext = path.extname(name).toLowerCase();
        if (!ALLOWED_EXT.includes(ext)) continue;
        const abs = path.join(this._outboxDir, name);
        try {
          const st = fs.statSync(abs);
          if (st.isFile()) onDisk.set(name, st);
        } catch {
          /* 单个文件读不到就跳过，不影响整体对账 */
        }
      }
    } catch {
      // outbox 不存在 = 从没导出过，不是错误
      return { added: 0, dropped: this._entries.size };
    }

    for (const id of [...this._entries.keys()]) {
      if (!onDisk.has(id)) {
        this._entries.delete(id);
        dropped += 1;
      }
    }

    for (const [name, st] of onDisk) {
      if (this._entries.has(name)) continue;
      this._entries.set(name, {
        id: name,
        fileName: name,
        format: formatFromFileName(name),
        title: titleFromFileName(name),
        bytes: st.size,
        createdAt: st.mtimeMs ? Math.floor(st.mtimeMs) : Date.now(),
        pinned: false,
      });
      added += 1;
    }

    return { added, dropped };
  }

  /** 原子写索引（tmp → rename）。失败只记 warn：索引坏了不该影响导出本身。 */
  save() {
    const items = [...this._entries.values()];
    const doc = { version: 1, items };
    try {
      fs.mkdirSync(path.dirname(this._indexPath), { recursive: true });
      const tmp = `${this._indexPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
      fs.renameSync(tmp, this._indexPath);
    } catch (err) {
      this._logger.warn?.(`[minipi:outcome] 索引写入失败：${err?.message ?? err}`);
    }
  }

  /**
   * 登记一次成功落盘（generate 后调用）。
   * @param {{ fileName: string, title?: string, bytes?: number, createdAt?: number }} meta
   */
  upsert(meta) {
    if (!this._loaded) this.load();
    const entry = normalizeEntry({
      fileName: meta?.fileName,
      title: meta?.title,
      bytes: meta?.bytes,
      createdAt: meta?.createdAt ?? Date.now(),
    });
    if (!entry) return null;
    this._entries.set(entry.id, entry);
    this.save();
    return entry;
  }

  /**
   * 列表：置顶优先，其次按时间倒序；`query` 匹配标题或文件名（大小写不敏感）。
   * @param {{ query?: string, limit?: number }} [input]
   */
  list(input = {}) {
    if (!this._loaded) this.load();
    const q = String(input?.query ?? "").trim().toLowerCase();
    let limit = Number.isFinite(input?.limit) ? Math.floor(input.limit) : 50;
    if (limit < 1) limit = 1;
    if (limit > 200) limit = 200;

    const items = [...this._entries.values()]
      .filter((e) => (q ? `${e.title} ${e.fileName}`.toLowerCase().includes(q) : true))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
      .slice(0, limit);
    return { items };
  }

  /** 取条目；不存在返回 null。 */
  get(id) {
    if (!this._loaded) this.load();
    return this._entries.get(String(id ?? "")) ?? null;
  }

  /**
   * 把条目拼成**绝对路径**并校验仍在 outbox 内（防索引被改成 `..\..\evil`）。
   * @returns {string|null}
   */
  absPathOf(id) {
    const entry = this.get(id);
    if (!entry) return null;
    const abs = path.resolve(this._outboxDir, entry.fileName);
    const root = path.resolve(this._outboxDir) + path.sep;
    return abs.startsWith(root) ? abs : null;
  }

  /**
   * 删除：文件移进 `trash/`（可恢复），并从索引移除。
   * @param {string} id
   * @returns {Promise<{ ok: true, trashedTo: string }>}
   */
  async remove(id) {
    const abs = this.absPathOf(id);
    if (!abs) {
      const err = new Error("产出不存在或路径越界");
      err.code = "OUTCOME_NOT_FOUND";
      throw err;
    }
    await fsp.mkdir(this._trashDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(this._trashDir, `${path.basename(abs)}.${stamp}`);
    await fsp.rename(abs, target);
    this._entries.delete(String(id));
    this.save();
    return { ok: true, trashedTo: target };
  }
}
