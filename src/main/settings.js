/**
 * `~/.minipi/settings.json` 的读写。
 *
 * 设计要点（对应角色守则「参数校验」「危险操作前置校验」）：
 *   · **白名单归一化**：只保留已知键，未知键一律丢弃，避免配置文件被写脏；
 *   · **范围夹紧**：坐标、窗口尺寸都有上下界，挡住 NaN / 负数爆炸 / 99999；
 *   · **原子落盘**：先写 `settings.json.tmp` 再 `rename`，中途断电不会留下半个文件；
 *   · **坏文件不致命**：JSON 解析失败 → 备份成 `settings.json.bad` 并用默认值启动，
 *     绝不让 App 因为一个坏掉的配置文件起不来。
 *
 * 本文件**不 import electron**，可在纯 Node 下测试。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  DEFAULT_SETTINGS,
  LIMITS,
  WINDOW_STATE_IDS,
  createDefaultSettings,
  isPlainObject,
  isSafeInt,
  sanitizePosition,
} from "../shared/protocol.js";

/** `~/.minipi`（方案 §3.2 / C13：outbox / repo / logs 全在这一根下）。 */
export const MINIPI_HOME = path.join(os.homedir(), ".minipi");

/** 设置文件绝对路径。 */
export const SETTINGS_PATH = path.join(MINIPI_HOME, "settings.json");

/** 事件 / 审计日志目录（v0.1 只创建目录，事件先只落内存）。 */
export const LOG_DIR = path.join(MINIPI_HOME, "logs");

/**
 * **产出抽屉**（plan §3.2 / §3.4.4，v0.4 新增）。
 *
 * 这是本产品的核心概念：用户**永远不选目录**，所有随手产出都落在这里。
 * 用户不该感知它的存在，只需要在产出卡片上点「打开 / 另存为」。
 */
export const OUTBOX_DIR = path.join(MINIPI_HOME, "outbox");

/** 需要预建的四场景 cwd（§3.2 场景表）。 */
export const SCENE_CWD_DIRS = Object.freeze({
  quick: OUTBOX_DIR,
  note: OUTBOX_DIR,
  desk: OUTBOX_DIR,
  repo: path.join(MINIPI_HOME, "repo"),
});

/** 允许写进 settings.json 的顶层键（其余丢弃）。 */
const ALLOWED_TOP_KEYS = Object.freeze(["version", "sceneId", "noFocusSteal", "window"]);

/**
 * v0.4 场景改名映射（plan §3.2 / §10 D-23）。
 *
 * 老用户的 `settings.json` 里可能还躺着 `speed` / `study` / `work`。
 * 这里做**静默映射**而不是报错——理由是：
 *   · 场景名不是用户资产，只是「他上次在哪」的记忆；
 *   · 为一个改名让 App 报错或重置用户设置，代价远大于收益；
 *   · 映射是**无损**的（语义一一对应，见下）。
 *
 * 注意 `study` → `note` 而非 `desk`：`note` 的定位（读长文/写笔记）更接近老 `study`。
 */
const LEGACY_SCENE_MAP = Object.freeze({
  speed: "quick",
  study: "note",
  work: "repo",
});

/**
 * 把历史场景名映射成 v0.4 的新名。**纯函数**。
 * 非历史名原样返回（合法性由 `scenes.js` 判定）。
 * @param {string} sceneId
 * @returns {string}
 */
export function migrateSceneId(sceneId) {
  if (typeof sceneId !== "string") return sceneId;
  return LEGACY_SCENE_MAP[sceneId] ?? sceneId;
}

/** 确保 `~/.minipi/{outbox,repo,logs}` 存在。 */
export function ensureAppDirs() {
  for (const dir of [...new Set([...Object.values(SCENE_CWD_DIRS), LOG_DIR])]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      // 建不出目录不致命：会话创建时还会再试一次，届时会给出可读错误
      console.warn(`[minipi:settings] 建目录失败 ${dir}：${err?.message ?? err}`);
    }
  }
}

/**
 * 白名单 + 夹紧 + 补默认值。**纯函数**，可单测。
 * @param {unknown} input 待归一化的对象
 * @param {object} [fallback] 缺省基准
 * @returns {object} 归一化后的设置
 */
export function normalizeSettings(input, fallback = DEFAULT_SETTINGS) {
  const base = isPlainObject(fallback) ? fallback : DEFAULT_SETTINGS;
  const out = createDefaultSettings();

  // 从 fallback 拷贝已知标量
  if (isSafeInt(base.version) && base.version > 0) out.version = base.version;
  if (typeof base.sceneId === "string") out.sceneId = migrateSceneId(base.sceneId);
  if (typeof base.noFocusSteal === "boolean") out.noFocusSteal = base.noFocusSteal;
  if (isPlainObject(base.window)) {
    if (typeof base.window.state === "string" && WINDOW_STATE_IDS.includes(base.window.state)) {
      out.window.state = base.window.state;
    }
    if (isPlainObject(base.window.positions)) {
      for (const state of WINDOW_STATE_IDS) {
        const p = sanitizePosition(base.window.positions[state]);
        if (p) out.window.positions[state] = p;
      }
    }
  }

  if (!isPlainObject(input)) return out;

  // 逐个已知键覆盖
  if (isSafeInt(input.version) && input.version > 0) out.version = input.version;

  if (typeof input.sceneId === "string") {
    // sceneId 合法性由调用方（scenes.js）判定；这里只做长度与类型兜底，
    // 保证 SettingsStore 不依赖 scenes.js，避免循环 import。
    // v0.4：历史场景名在这里**静默迁移**（speed→quick / study→note / work→repo）。
    const s = migrateSceneId(input.sceneId.trim());
    if (s.length > 0 && s.length <= LIMITS.SCENE_ID_MAX_CHARS) out.sceneId = s;
  }

  if (typeof input.noFocusSteal === "boolean") out.noFocusSteal = input.noFocusSteal;

  if (isPlainObject(input.window)) {
    if (typeof input.window.state === "string" && WINDOW_STATE_IDS.includes(input.window.state)) {
      out.window.state = input.window.state;
    }
    if (isPlainObject(input.window.positions)) {
      for (const state of WINDOW_STATE_IDS) {
        const p = sanitizePosition(input.window.positions[state]);
        if (p) out.window.positions[state] = p;
      }
    }
  }

  // 未知顶层键：显式丢弃（白名单）
  for (const key of Object.keys(input)) {
    if (!ALLOWED_TOP_KEYS.includes(key)) {
      console.warn(`[minipi:settings] 丢弃未知设置键：${String(key).slice(0, 40)}`);
    }
  }

  return out;
}

/** 递归冻结，防止调用方改到内部状态。 */
function deepFreeze(obj) {
  if (!obj || typeof obj !== "object" || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const v of Object.values(obj)) deepFreeze(v);
  return obj;
}

/** 设置存储：同步读（启动时一次）、同步写（原子）。 */
export class SettingsStore {
  /**
   * @param {{ filePath?: string }} [options]
   */
  constructor(options = {}) {
    this.filePath = options.filePath || SETTINGS_PATH;
    /** @type {object} */
    this._data = createDefaultSettings();
    /** @type {string[]} */
    this.warnings = [];
  }

  /** 从磁盘载入；文件不存在 → 用默认值并立刻落盘一份。 */
  load() {
    this.warnings = [];
    try {
      if (!fs.existsSync(this.filePath)) {
        this._data = createDefaultSettings();
        this.persist();
        this.warnings.push("settings.json 不存在，已写入默认值");
        return this.get();
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      if (raw.length > LIMITS.SETTINGS_JSON_MAX_BYTES) {
        throw new Error("settings.json 体积超限");
      }
      // 记事本 / PowerShell 5.1 的 `-Encoding utf8` 会写 UTF-8 **BOM**，
      // 而 JSON.parse 不认 BOM（会抛 `Unexpected token '\uFEFF'`）。
      // 用户手改设置文件是真实场景，这里先剥掉再解析。
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const parsed = JSON.parse(text);
      this._data = normalizeSettings(parsed);
      return this.get();
    } catch (err) {
      // 坏文件不致命：备份后回到默认值
      const msg = `settings.json 读取失败，已回退默认值：${err?.message ?? err}`;
      console.warn(`[minipi:settings] ${msg}`);
      this.warnings.push(msg);
      try {
        const bad = `${this.filePath}.bad`;
        if (fs.existsSync(this.filePath)) fs.copyFileSync(this.filePath, bad);
      } catch {
        /* 备份失败就算了，不要因为备份把启动搞崩 */
      }
      this._data = createDefaultSettings();
      this.persist();
      return this.get();
    }
  }

  /** @returns {object} 归一化设置（深拷贝，调用方随便改） */
  get() {
    return structuredClone(this._data);
  }

  /**
   * 合并式更新（**只接受已知键**）。
   * @param {unknown} partial
   * @returns {object} 更新后的设置
   * @throws {Error} partial 不是普通对象 / 体积超限
   */
  set(partial) {
    if (!isPlainObject(partial)) {
      throw new Error("设置必须是一个普通对象");
    }
    const keys = Object.keys(partial);
    if (keys.length === 0) return this.get();

    let serialized;
    try {
      serialized = JSON.stringify(partial);
    } catch {
      throw new Error("设置里有无法序列化的值");
    }
    if (serialized.length > LIMITS.SETTINGS_JSON_MAX_BYTES) {
      throw new Error("设置体积超限");
    }

    const merged = structuredClone(this._data);
    if (typeof partial.noFocusSteal === "boolean") merged.noFocusSteal = partial.noFocusSteal;
    if (typeof partial.sceneId === "string") merged.sceneId = partial.sceneId;
    if (isSafeInt(partial.version) && partial.version > 0) merged.version = partial.version;
    if (isPlainObject(partial.window)) {
      if (typeof partial.window.state === "string" && WINDOW_STATE_IDS.includes(partial.window.state)) {
        merged.window.state = partial.window.state;
      }
      if (isPlainObject(partial.window.positions)) {
        for (const state of WINDOW_STATE_IDS) {
          if (!(state in partial.window.positions)) continue;
          const p = sanitizePosition(partial.window.positions[state]);
          if (p) merged.window.positions[state] = p;
        }
      }
    }

    this._data = normalizeSettings(merged, merged);
    this.persist();
    return this.get();
  }

  /**
   * 记一次窗口位置（拖拽结束 / 变形完成后调用）。
   * @param {"ball"|"mini"|"full"} state
   * @param {{x:number,y:number}} bounds
   */
  recordPosition(state, bounds) {
    if (!WINDOW_STATE_IDS.includes(state)) return false;
    const p = sanitizePosition({ x: bounds?.x, y: bounds?.y });
    if (!p) return false;
    const cur = this._data.window.positions[state];
    if (cur && cur.x === p.x && cur.y === p.y) return false; // 没变就不落盘
    this._data.window.positions[state] = p;
    this.persist();
    return true;
  }

  /** 记一次形态。 */
  recordState(state) {
    if (!WINDOW_STATE_IDS.includes(state)) return false;
    if (this._data.window.state === state) return false;
    this._data.window.state = state;
    this.persist();
    return true;
  }

  /** 原子写盘。 */
  persist() {
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(this._data, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch (err) {
      console.warn(`[minipi:settings] 写盘失败：${err?.message ?? err}`);
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return false;
    }
  }
}
