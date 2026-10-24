/**
 * 会话自建存储（D-09 / B1-3）：让「关掉再打开还能找回」成立。
 *
 * 为什么必须自建（而不是继续用 Pi 的默认会话目录）：
 *   现状 `SessionManager.create(cwd)` 没传 sessionDir ⇒ 会话 JSONL 落在
 *   `~/.pi/agent/sessions/<encoded-cwd>/`，与 Pi CLI **共用同一个目录**。
 *   那是别人的储物柜：我们既不能保证命名/清理策略，也不能在里面维护自己的元数据。
 *   D-09 因此拍板：**正文落 `~/.minipi/sessions/`，元数据索引也由我们维护**。
 *
 * 布局（plan §2.1）：
 * ```
 * ~/.minipi/sessions/
 * ├── index.json      # 唯一真源：标题 / 置顶 / 归档 / 场景 / 时间 / 预览
 * ├── <ts>_<id>.jsonl # Pi 的 SessionManager 写的会话正文（append-only）
 * └── .trash/         # 删除的会话（可恢复；v1 不做物理清理）
 * ```
 *
 * ⚠ **文件名不是 `<id>.jsonl`**（这一点与 plan §2.1 的示意图不同，实现取 SDK 的真实命名）：
 *   `SessionManager.newSession()` 把文件名定死为 `<ISO 时间戳>_<sessionId>.jsonl`
 *   （`dist/core/session-manager.js:713`），且是**懒创建**——只有会话里出现第一条
 *   user/assistant 消息时才会 `openSync(path, "wx")` 落盘。所以：
 *     · 我们不可能在 create 时就把它改名成 `<id>.jsonl`（文件还不存在）；
 *     · 也不能预建一个空文件占位（SDK 用 `"wx"` 打开，已存在会直接抛 EEXIST）。
 *   于是 `pathOf(id)` 改成**按后缀解析**：在会话目录里找 `*_<id>.jsonl`。
 *   id 自带 `s_` 前缀且字符集受限，后缀匹配不会串到别的会话上。
 *
 * ⚠ **对账的留白**：plan 写「索引有、文件无 ⇒ 删条目」。但刚建好的会话在用户发出
 *   第一条消息之前**没有文件**（见上）。若严格删除，用户「新建会话 → 打开列表」
 *   就会看到它凭空消失。所以本进程内新建的 id 记在 `_pending` 里，对账时**保留**；
 *   重启之后 `_pending` 为空，这种「建了但一条消息都没发」的空会话才会被清掉
 *   （它本来也没有任何内容可找回）。
 *
 * 本模块**不 import electron / 不 import Pi SDK**，可在纯 Node 下完整测试
 * （`scripts/verify-sessions.mjs` 就是这么跑的）。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_SCENE_ID,
  LIMITS,
  SESSION_DEFAULT_TITLE,
  isSceneId,
  isSessionId,
} from "../shared/protocol.js";

import { MINIPI_HOME } from "./settings.js";

/** 会话正文 + 索引 + 回收站的根目录（D-09：我们自己的目录）。 */
export const SESSIONS_DIR = path.join(MINIPI_HOME, "sessions");

/** 元数据索引文件。 */
export const SESSIONS_INDEX_PATH = path.join(SESSIONS_DIR, "index.json");

/** 删除去向（可恢复；v1 不做 30 天清理）。 */
export const SESSIONS_TRASH_DIR = path.join(SESSIONS_DIR, ".trash");

/** 索引文件里的版本号（将来字段迁移用；当前只写不读）。 */
const INDEX_VERSION = 1;

/**
 * 文件 → id 的解析正则。
 * SDK 的文件名是 `<ISO 时间戳>_<id>.jsonl`，id 由我们生成（`s_<base36 秒>_<4 位>`），
 * 所以「以 `_s_xxx_yyyy.jsonl` 结尾」就能唯一确定 id。
 */
const FILE_ID_RE = /(s_[a-z0-9]+_[a-z0-9]{4})\.jsonl$/;

/**
 * 造一个新会话 id：`s_<base36 秒时间戳>_<4 位随机>`。
 *
 * 为什么不用 UUID：这个 id 会出现在**文件名**里、在 UI 的开发者信息里，
 * 短一点更好读；秒级时间戳 + 36⁴ 随机（约 168 万）在这个产品的量级（单机单用户）
 * 足够唯一。真撞了就重试（见下）。
 *
 * @param {number} [now]
 * @returns {string}
 */
export function newSessionId(now = Date.now()) {
  const stamp = Math.floor(now / 1000).toString(36);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let rand = "";
    for (let i = 0; i < 4; i += 1) {
      rand += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)];
    }
    const id = `s_${stamp}_${rand}`;
    if (isSessionId(id)) return id;
  }
  // 理论上到不了这里（上面必然产出合法形状）；兜底给出确定性 id，保证调用方拿得到字符串
  return `s_${stamp}_aaaa`;
}

/**
 * 按**码点**截断（不劈代理对）。
 *
 * 为什么不能用 `String.prototype.slice`：它按 UTF-16 code unit 计数，
 * `"😀😀"` 截 1 会得到**孤立高代理**（渲染出来是 `�`，JSON 里也是坏字符）。
 * 标题 / 预览 / 历史回填三处共用这一个函数 —— Tess 的 BUG-1 只修了标题，
 * 预览与 `_historyOf` 漏了，这次一起收敛。
 *
 * @param {unknown} raw
 * @param {number} max 码点上限
 * @returns {string}
 */
export function sliceByCodePoint(raw, max) {
  const s = String(raw ?? "");
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  if (limit === 0) return "";
  // 先用 code unit 快速判：不够长就不用 Array.from（大多数情况走这条）
  if (s.length <= limit) return s;
  return Array.from(s).slice(0, limit).join("");
}

/**
 * 标题归一：压缩空白、截 24 字（按码点）、空串回「新会话」。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeSessionTitle(raw) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (s.length === 0) return SESSION_DEFAULT_TITLE;
  return sliceByCodePoint(s, LIMITS.SESSION_TITLE_MAX_CHARS);
}

/**
 * 预览归一：最后一条用户消息的前 60 字（压成单行，按码点截断）。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeSessionPreview(raw) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  return sliceByCodePoint(s, LIMITS.SESSION_PREVIEW_MAX_CHARS);
}

/**
 * 索引条目归一（防手改索引塞进危险字段 / 错误类型）。
 * **字段集合冻结**（plan §2.1）：多一个少一个都算契约漂移。
 *
 * @param {unknown} raw
 * @returns {null | {id:string,title:string,sceneId:string,pinned:boolean,archived:boolean,
 *   createdAt:number,updatedAt:number,preview:string,lastSeq:number}}
 */
export function normalizeSessionEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!isSessionId(id)) return null;
  const createdAt = Number.isFinite(raw.createdAt) ? Math.floor(raw.createdAt) : 0;
  const updatedAt = Number.isFinite(raw.updatedAt) ? Math.floor(raw.updatedAt) : createdAt;
  return {
    id,
    title: normalizeSessionTitle(raw.title),
    sceneId: isSceneId(raw.sceneId) ? raw.sceneId : DEFAULT_SCENE_ID,
    pinned: raw.pinned === true,
    archived: raw.archived === true,
    createdAt,
    updatedAt,
    preview: normalizeSessionPreview(raw.preview),
    lastSeq: Number.isFinite(raw.lastSeq) ? Math.max(0, Math.floor(raw.lastSeq)) : 0,
  };
}

/** 条目的对外副本（调用方随便改，不动内部状态）。 */
const copy = (item) => ({ ...item });

/**
 * minipi 自己的会话元数据索引。
 *
 * 一句话：**索引是唯一真源**（标题 / 置顶 / 归档 / 场景 / 时间 / 预览），
 * 会话正文（JSONL）是 Pi 的地盘 —— 我们只负责把它放在自己的目录里、按 id 找回来。
 */
export class SessionStore {
  /**
   * @param {object} [deps]
   * @param {string} [deps.dir]       会话目录（测试注入临时目录）
   * @param {string} [deps.indexPath] 索引文件（默认 `<dir>/index.json`）
   * @param {string} [deps.trashDir]  回收站目录（默认 `<dir>/.trash`）
   * @param {{warn?:Function,info?:Function}} [deps.logger]
   */
  constructor(deps = {}) {
    this._dir = deps.dir || SESSIONS_DIR;
    this._indexPath = deps.indexPath || path.join(this._dir, "index.json");
    this._trashDir = deps.trashDir || path.join(this._dir, ".trash");
    this._logger = deps.logger ?? console;
    /** @type {Map<string, object>} id → 归一化条目（插入顺序即创建顺序） */
    this._entries = new Map();
    /**
     * 本进程内「已建但文件还没落盘」的 id（SDK 懒创建，见文件头对账说明）。
     * @type {Set<string>}
     */
    this._pending = new Set();
    this._loaded = false;
  }

  /** 会话目录绝对路径（`pathOf` / 恢复时的 sessionDir 参数都用它）。 */
  get dir() {
    return this._dir;
  }

  /** 索引文件绝对路径。 */
  get indexPath() {
    return this._indexPath;
  }

  /** 回收站目录绝对路径。 */
  get trashDir() {
    return this._trashDir;
  }

  /* ------------------------------------------------------------ 读 */

  /**
   * 读索引 + 与目录对账。**幂等**，可反复调用（第一次访问时自动调）。
   * @returns {{items:number, added:number, dropped:number, repaired:boolean}}
   */
  load() {
    let repaired = false;
    /** @type {unknown[]} */
    let raw = [];
    try {
      const text = fs.readFileSync(this._indexPath, "utf8");
      const doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      raw = Array.isArray(doc?.items) ? doc.items : [];
    } catch (err) {
      if (err?.code !== "ENOENT") {
        // 坏索引：改名保留现场（`.bad-<ts>`），再重建 —— 不静默丢用户数据
        repaired = true;
        try {
          fs.renameSync(this._indexPath, `${this._indexPath}.bad-${Date.now()}`);
        } catch {
          /* 改名失败也不该拖垮启动 */
        }
        this._logger.warn?.(`[minipi:session] 索引损坏，已备份重建：${err?.message ?? err}`);
      }
    }

    this._entries.clear();
    for (const item of raw) {
      const entry = normalizeSessionEntry(item);
      if (entry) this._entries.set(entry.id, entry);
      else this._logger.warn?.("[minipi:session] 索引里有非法条目，已丢弃");
    }
    this._loaded = true;

    const rec = this._reconcile();
    /* ⚠ 只在**对账成功**时才落盘：`_reconcile` 因为 fs 错误（EACCES / 句柄占用）
       提前返回 error 时，索引必须一个字节都不动 —— 否则一次瞬时错误就把用户索引抹平。 */
    if (!rec.error && (rec.added || rec.dropped || repaired)) this.save();
    return { items: this._entries.size, added: rec.added, dropped: rec.dropped, repaired, error: rec.error === true };
  }

  /** 是否已加载（对账过一次）。 */
  get loaded() {
    return this._loaded;
  }

  /**
   * 列会话。默认只列**未归档**，按 `pinned desc + updatedAt desc` 排序（plan §2.2）。
   * @param {{query?:string, archived?:boolean}} [input]
   * @returns {{items: Array<object>}}
   */
  list(input = {}) {
    this._ensureLoaded();
    const q = String(input?.query ?? "").trim().toLowerCase();
    const wantArchived = input?.archived === true;
    let items = [...this._entries.values()].filter((e) => e.archived === wantArchived);
    if (q) items = items.filter((e) => `${e.title} ${e.preview}`.toLowerCase().includes(q));
    items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    return { items: items.slice(0, LIMITS.SESSION_LIST_MAX).map(copy) };
  }

  /**
   * 取一条；不存在返回 null。
   * @param {string} id
   */
  get(id) {
    this._ensureLoaded();
    const entry = this._entries.get(String(id ?? ""));
    return entry ? copy(entry) : null;
  }

  /** 索引里登记了多少条（含归档）。 */
  get size() {
    this._ensureLoaded();
    return this._entries.size;
  }

  /**
   * 会话正文的**绝对路径**；文件不存在（或 id 非法）返回 null。
   *
   * 按后缀在目录里解析（理由见文件头）：`<ts>_<id>.jsonl`。
   * 结果必须落在会话目录内 —— 双重保险（id 已由正则限定字符集）。
   *
   * @param {string} id
   * @returns {string|null}
   */
  pathOf(id) {
    if (!isSessionId(id)) return null;
    const root = path.resolve(this._dir);
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      return null; // 目录还没建 = 从来没有会话
    }
    const suffix = `_${id}.jsonl`;
    const hit = names.find((name) => name.endsWith(suffix) && name.length > suffix.length);
    if (!hit) return null;
    const abs = path.resolve(root, hit);
    return abs.startsWith(root + path.sep) ? abs : null;
  }

  /* ------------------------------------------------------------ 写 */

  /**
   * 建一条会话记录。
   *
   * `createManager` 是**注入的**（`session.js` 传 `SessionManager.create`）：
   * 本模块不 import Pi SDK —— 索引层的测试不该被模型运行时的依赖拖下水。
   * 不注入时只写索引条目（纯 Node 测试就是这个形态）。
   *
   * @param {string} cwd 场景 cwd（交给 Pi 的 SessionManager）
   * @param {string} sceneId
   * @param {{id?:string, createManager?: (cwd:string, dir:string, opts:{id:string}) => unknown}} [options]
   * @returns {{item: object, sessionManager: unknown|null}}
   */
  create(cwd, sceneId, options = {}) {
    this._ensureLoaded();
    const now = Date.now();
    let id = isSessionId(options?.id) ? options.id : newSessionId(now);
    // 极端情况（同秒 + 同随机）撞上已有条目/已有文件时换一个，别把两条会话写进一份正文
    if (!isSessionId(options?.id)) {
      let guard = 0;
      while ((this._entries.has(id) || this.pathOf(id) !== null) && guard < 8) {
        id = newSessionId(now + guard);
        guard += 1;
      }
    }

    let sessionManager = null;
    if (typeof options?.createManager === "function") {
      sessionManager = options.createManager(cwd, this._dir, { id });
    }

    const item = {
      id,
      title: SESSION_DEFAULT_TITLE,
      sceneId: isSceneId(sceneId) ? sceneId : DEFAULT_SCENE_ID,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      preview: "",
      lastSeq: 0,
    };
    this._entries.set(id, item);
    // 正文要等第一条消息才落盘（SDK 懒创建）⇒ 先记成 pending，别被对账清掉
    this._pending.add(id);
    this.save();
    return { item: copy(item), sessionManager };
  }

  /**
   * 改名。标题截 24 字，空串回「新会话」（plan §2.2）。
   * @param {string} id
   * @param {unknown} title
   * @returns {object|null} 更新后的条目；id 不存在返回 null
   */
  rename(id, title) {
    this._ensureLoaded();
    const entry = this._entries.get(String(id ?? ""));
    if (!entry) return null;
    entry.title = normalizeSessionTitle(title);
    entry.updatedAt = Date.now();
    this.save();
    return copy(entry);
  }

  /**
   * 置顶 / 取消置顶。**不动文件**（只是索引上的排序权重）。
   * @param {string} id
   * @param {unknown} pinned
   * @returns {object|null}
   */
  setPinned(id, pinned) {
    this._ensureLoaded();
    const entry = this._entries.get(String(id ?? ""));
    if (!entry) return null;
    entry.pinned = pinned === true;
    // 置顶只改标记，不动 updatedAt：否则取消置顶会把它顶到最前（Tess BUG-5）
    this.save();
    return copy(entry);
  }

  /**
   * 归档 / 取消归档。**不移动文件、不删数据**（plan §2.2）。
   * @param {string} id
   * @param {unknown} archived
   * @returns {object|null}
   */
  setArchived(id, archived) {
    this._ensureLoaded();
    const entry = this._entries.get(String(id ?? ""));
    if (!entry) return null;
    entry.archived = archived === true;
    // 归档同理：归档不是「有新内容」
    this.save();
    return copy(entry);
  }

  /**
   * 删除：正文移进 `.trash/`（可恢复），索引条目移除。
   * **v1 不做物理清理**（30 天清理留 P2）。
   *
   * ⚠ `options.isStreaming` 是**正在写盘的护栏**（BLK-1 的存储层那一半）：
   *   会话还在跑的时候挪走正文，Pi 下一次 `appendFileSync` 会把文件**原样重建**成一个
   *   没有 session header 的同名 jsonl（`session-manager.js:812`），重启后按文件名被
   *   `_idOfFile` 认领 ⇒ 已删会话原地复活、内容只剩删除后那几句。
   *
   *   ⚠ 语义是「**正在写 ⇒ 不许删**」，**不是**「活着一律不许删」：
   *     刚建的空会话本来就在内存里活着，用户想删掉它是完全正常的动作（它连文件都还没有）。
   *     所以调用方的正确顺序是：流式中 → 拒绝；活着但空闲 → 先 dispose（摘掉写入者）→ 再删。
   *     这个钩子是**最后的保险**（万一 dispose 没成功），P1 的批量删除也必须经过这里。
   *
   *   ⚠ 存储层不认识 Pi：钩子由 `main/index.js` 注入（`deps.isStreaming`）。
   *
   * @param {string} id
   * @param {{isStreaming?: () => boolean}} [options]
   * @returns {Promise<{ok:true, trashedTo:string|null}>}
   * @throws 条目不存在 → `Error{code:"SESSION_NOT_FOUND"}`；会话正在写 → `Error{code:"SESSION_BUSY"}`
   */
  async remove(id, options = {}) {
    this._ensureLoaded();
    const key = String(id ?? "");
    if (!this._entries.has(key)) {
      const err = new Error("会话不存在");
      err.code = "SESSION_NOT_FOUND";
      throw err;
    }
    if (typeof options.isStreaming === "function" && options.isStreaming()) {
      const err = new Error("会话正在生成回答，不能删除");
      err.code = "SESSION_BUSY";
      throw err;
    }
    const abs = this.pathOf(key);
    let trashedTo = null;
    if (abs) {
      await fsp.mkdir(this._trashDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      trashedTo = path.join(this._trashDir, `${path.basename(abs)}.${stamp}`);
      await fsp.rename(abs, trashedTo);
    }
    this._entries.delete(key);
    this._pending.delete(key);
    this.save();
    return { ok: true, trashedTo };
  }

  /**
   * 记一次活动（`session.js` 在事件流上调，已由调用方节流）。
   *
   * 三件事：
   *   1. `preview` = 最后一条用户消息前 60 字；
   *   2. `title` **只在还是默认值时**从 preview 取前 24 字（用户改过就不许覆盖）；
   *   3. `updatedAt` / `lastSeq` 刷新（列表靠它排序）。
   *
   * @param {string} id
   * @param {{preview?:unknown, lastSeq?:number}} patch
   * @returns {object|null}
   */
  touch(id, patch = {}) {
    this._ensureLoaded();
    const entry = this._entries.get(String(id ?? ""));
    if (!entry) return null;

    if (patch.preview !== undefined) {
      const preview = normalizeSessionPreview(patch.preview);
      if (preview) entry.preview = preview;
    }
    if (Number.isFinite(patch.lastSeq) && patch.lastSeq >= 0) {
      entry.lastSeq = Math.max(entry.lastSeq, Math.floor(patch.lastSeq));
    }
    if (entry.title === SESSION_DEFAULT_TITLE && entry.preview) {
      entry.title = normalizeSessionTitle(entry.preview);
    }
    entry.updatedAt = Date.now();
    // 文件已落盘 ⇒ 从 pending 里摘掉（之后对账就按磁盘说了算）
    if (this._pending.has(entry.id) && this.pathOf(entry.id) !== null) this._pending.delete(entry.id);
    this.save();
    return copy(entry);
  }

  /** 原子写索引（tmp → rename）。失败只 warn：索引坏了不该让会话本身不可用。 */
  save() {
    const doc = { version: INDEX_VERSION, items: [...this._entries.values()] };
    try {
      fs.mkdirSync(path.dirname(this._indexPath), { recursive: true });
      const tmp = `${this._indexPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, this._indexPath);
      return true;
    } catch (err) {
      this._logger.warn?.(`[minipi:session] 索引写入失败：${err?.message ?? err}`);
      try {
        const tmp = `${this._indexPath}.tmp-${process.pid}`;
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  /* --------------------------------------------------------- 内部 */

  _ensureLoaded() {
    if (!this._loaded) this.load();
  }

  /**
   * 与磁盘对账（plan §3「对账」）：
   *   · 索引有、文件无 ⇒ 删条目（**除了本进程刚建、文件还没落盘的**，见文件头）
   *   · 文件有、索引无 ⇒ 补条目（标题「新会话」；时间取文件 mtime）
   *
   * ⚠ **读目录失败要分两种**（否则一次 EACCES 就把用户索引抹平）：
   *   · `ENOENT` = 目录还不存在 = 从来没有会话 ⇒ 按"空目录"处理是对的；
   *   · 其它错误（权限 / 句柄占用 / 磁盘故障）⇒ **不动索引、不 save**，
   *     返回 `{error:true}` 让 `load()` 跳过落盘，下次再对。
   *
   * @returns {{added:number, dropped:number, error?:boolean}}
   */
  _reconcile() {
    let added = 0;
    let dropped = 0;

    /** @type {Map<string, {name:string, mtimeMs:number, size:number}>} */
    const onDisk = new Map();
    try {
      for (const name of fs.readdirSync(this._dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const abs = path.join(this._dir, name);
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue; // 单个文件读不到就跳过，不影响整体对账
        }
        if (!st.isFile()) continue;
        const id = this._idOfFile(abs, name);
        if (!id) continue;
        onDisk.set(id, { name, mtimeMs: st.mtimeMs || 0, size: st.size });
      }
    } catch (err) {
      if (err?.code !== "ENOENT") {
        // 真实故障：保持索引原样（不 clear、不 save），只记一条 warn
        this._logger.warn?.(
          `[minipi:session] 对账读目录失败，索引保持不变：${err?.message ?? err}`,
        );
        return { added: 0, dropped: 0, error: true };
      }
      // 目录不存在 = 从来没有会话，不是错误：此时所有条目都是幽灵（除 pending 外）
      for (const id of [...this._entries.keys()]) {
        if (this._pending.has(id)) continue;
        this._entries.delete(id);
        dropped += 1;
      }
      return { added: 0, dropped };
    }

    for (const id of [...this._entries.keys()]) {
      if (onDisk.has(id)) continue;
      if (this._pending.has(id)) continue; // 刚建、正文还没落盘
      this._entries.delete(id);
      dropped += 1;
    }

    for (const [id, meta] of onDisk) {
      if (this._entries.has(id)) continue;
      const created = meta.mtimeMs > 0 ? Math.floor(meta.mtimeMs) : Date.now();
      this._entries.set(id, {
        id,
        title: SESSION_DEFAULT_TITLE,
        sceneId: DEFAULT_SCENE_ID,
        pinned: false,
        archived: false,
        createdAt: created,
        updatedAt: created,
        preview: "",
        lastSeq: 0,
      });
      added += 1;
    }

    return { added, dropped };
  }

  /**
   * 从 JSONL 首行（session header）反推 id。
   *
   * ⚠ **必须读首行，不能只看文件名**（BLK-1 的存储层兜底，2026-10-23 修）：
   *   Pi 的 `_persist()` 在 `flushed` 之后走 `appendFileSync`，**文件不在就会把它重建**
   *   （`session-manager.js`）；重建出来的文件只有后续消息、**没有 session header**。
   *   删除会话时 `remove()` 把正文移进 `.trash/`，若还有活着的 `AgentSession` 再写一条，
   *   原路径就会冒出这样一份「文件名像我们的、内容却不是合法会话」的残片。
   *   只看文件名认领它 ⇒ **已删会话在重启后复活**（且标题/预览全空、正文只剩删除后那几句）。
   *   所以判据是：**能读到首行且明确不是 header ⇒ 拒**；读不到 ⇒ 保守按文件名认领（见下）。
   *
   * header 里的 id 也必须过形状校验 —— 从 Pi CLI 目录拷进来的 UUID 会话我们没法用
   * `findById` / `resumeSession` 指代，干脆不认（记一条 warn）。
   *
   * ⚠ 这里**只做「不认领」，不删文件**：残片的物理清理留 P2（`remove()` 语义之外的动作
   * 不该藏在一次目录扫描里，误删代价太高）。
   *
   * ⚠⚠ **「读不了」不等于「不是会话」**（2026-10-23 自查补的，原实现会误伤）：
   *   `fs.openSync` / `readSync` 可能因为 EACCES、文件被独占、磁盘抖动而抛错。
   *   那时我们**没有证据**说这份文件是残片 —— 按"不认识"处理会导致
   *   **合法会话在重启后从列表里消失**（用户视角就是"我的会话没了"），
   *   这比"多认领一个残片"严重得多（残片顶多多一行空会话，删一次就没了）。
   *   所以：**首行明确不是 header ⇒ 才拒**；**读都读不到 ⇒ 保守按文件名认领**。
   *   同理，首行超出读取窗口（超长 cwd）也算"读不全"，保守认领。
   *
   * @param {string} abs
   * @param {string} name
   * @returns {string|null}
   */
  _idOfFile(abs, name) {
    const byName = FILE_ID_RE.exec(name);
    const nameId = byName && isSessionId(byName[1]) ? byName[1] : null;

    /** 读不到 / 读不全时的保守处理：有文件名就按文件名认领，避免误删合法会话。 */
    const keepByName = (why) => {
      if (!nameId) return null;
      this._logger.warn?.(
        `[minipi:session] ${why}，暂按文件名认领会话（重启后请留意）：${name}`,
      );
      return nameId;
    };

    let head = "";
    let sawNewline = false;
    try {
      const fd = fs.openSync(abs, "r");
      try {
        /* 64KB 足够容纳任何正常 header（实测只有几百字节）；读不满就说明首行异常长。
           注意 readSync 只返回文件里真实存在的字节数，缓冲开大不浪费 IO。 */
        const buf = Buffer.alloc(64 * 1024);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        head = buf.subarray(0, read).toString("utf8");
        sawNewline = head.includes("\n");
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return keepByName(`读取会话文件失败（${err?.code ?? err?.message ?? err}）`);
    }

    if (!sawNewline && head.length >= 64 * 1024) {
      // 64KB 里都没有换行 = 首行异常（不是我们写的那种一行一 JSON 的文件）
      return keepByName("会话文件首行异常长，无法确认 header");
    }

    const firstLine = head.split("\n")[0] ?? "";
    let header = null;
    try {
      header = JSON.parse(firstLine);
    } catch {
      // 首行不是 JSON：空文件 / 被截断 / 别的程序写的 —— 同样属于"没有证据"
      return keepByName("会话文件首行不是 JSON");
    }

    const id = typeof header?.id === "string" ? header.id : "";
    // 只认「文件名确实以该 id 结尾」的：否则 pathOf() 找不到它，条目会变成幽灵
    if (header?.type === "session" && isSessionId(id) && name.endsWith(`${id}.jsonl`)) {
      return id;
    }

    /* 走到这里 = 首行是合法 JSON、但**明确不是** session header。
       文件名又像我们的会话 ⇒ 这就是删除后 SDK 重建的残片，认领它等于让已删会话复活。
       注意空文件也走不到这里（JSON.parse("") 会抛，已被上面接住）。 */
    if (nameId) {
      this._logger.warn?.(
        `[minipi:session] 忽略无 header 的会话残片（否则已删会话会复活）：${name}`,
      );
      return null;
    }
    this._logger.warn?.(`[minipi:session] 忽略无法识别的会话文件：${name}`);
    return null;
  }
}
