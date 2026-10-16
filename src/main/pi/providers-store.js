/**
 * **minipi 自己的「提供方定义」存储**（`~/.minipi/providers.json`）。
 *
 * ## 为什么要有这个文件（而不是直接用 Pi 的 models.json）
 *
 * Pi 也支持自定义提供方，但那份配置住在 `~/.pi/agent/models.json` —— 那是 **Pi 的文件**：
 *   · 本机那份里已经有用户自己的 `evo`（**含明文 apiKey**）；我们去写它，等于把
 *     别人的配置置于被我们整段重写的风险之下；
 *   · 本仓库已经立过规矩：`credentials-store.js` 明确「绝不改动 Pi 的文件」。
 *
 * 所以 minipi 自定义的提供方**只存在自己的目录里**，启动/变更时通过 Pi 的公开 API
 * `ModelRuntime.registerProvider()` 注入到运行时。代价与边界都写清楚：
 *   · ✅ 重启后仍在（存在自己的文件里）；
 *   · ✅ 立即生效（registerProvider 是同步的），新会话即可选中；
 *   · ❌ **Pi CLI（`pi` 命令）看不到** minipi 的自定义提供方 —— 这是刻意的范围划分。
 *
 * ## 这个文件里**只有结构，没有密钥**
 *
 * `apiKey` 一律不进这里：密钥走既有的 `~/.minipi/credentials.json`
 * （`credentials-store.js`），UI 也是「只写不读」。
 * ⚠ 这跟 Pi 的 models.json 支持 `apiKey: "sk-..."` 字面量**不同** —— 我们是故意不支持的，
 *   「提供一个能把明文密钥写进配置文件的入口」不是特性，是负债。
 *
 * ## 语义：存在即覆盖
 *
 * 一个 id 出现在这里，就在运行时被 `registerProvider(id, …)` 覆盖：
 *   · id 是**内置**提供方 → 覆盖它（给 `models` 就是替换整个模型目录，只给 `baseUrl` 就是换端点）；
 *   · id 是**新的** → 就是一个自定义提供方。
 * 删掉这个 id 就走 `unregisterProvider(id)` —— 内置的会**回落到原始定义**（实测：
 * unregister 只摘掉覆盖层，内置 provider 与模型都不丢）。
 *
 * 本文件**不 import Pi SDK、不 import electron**，可在纯 Node 下完整测试。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { LIMITS, PROVIDER_API_IDS, PROVIDER_ID_PATTERN_SOURCE, isPlainObject } from "../../shared/protocol.js";

/** `~/.minipi/providers.json`。 */
export const PROVIDERS_PATH = path.join(os.homedir(), ".minipi", "providers.json");

/** 自定义提供方 id 的形态（与 protocol.js 的唯一真源同步）。 */
const PROVIDER_ID_RE = new RegExp(PROVIDER_ID_PATTERN_SOURCE);

/** 当前存储结构版本；将来改结构时用它做迁移。 */
export const PROVIDERS_VERSION = 1;

/**
 * 单个模型条目的归一化。
 * @param {unknown} raw
 * @returns {{ id: string, name?: string, contextWindow?: number, maxTokens?: number } | null}
 */
export function normalizeProviderModel(raw) {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : typeof raw.modelId === "string" ? raw.modelId.trim() : "";
  if (!id || id.length > LIMITS.PROVIDER_MODEL_ID_MAX_CHARS) return null;

  const out = { id };
  if (typeof raw.name === "string" && raw.name.trim().length > 0) {
    out.name = raw.name.trim().slice(0, LIMITS.PROVIDER_MODEL_NAME_MAX_CHARS);
  }
  // 容量只收正整数：负数 / NaN / 浮点一律丢弃（丢弃比夹到边界更诚实 —— 不会伪装成有效值）
  for (const key of ["contextWindow", "maxTokens"]) {
    const v = raw[key];
    if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) out[key] = v;
  }
  return out;
}

/**
 * 单个提供方定义的归一化。**失败返回 null**（调用方据此报 PROVIDER_INVALID）。
 *
 * @param {string} providerId
 * @param {unknown} raw
 * @returns {{ provider: string, displayName?: string, baseUrl?: string, api?: string, models?: object[] } | null}
 */
export function normalizeProviderDefinition(providerId, raw) {
  if (typeof providerId !== "string") return null;
  const provider = providerId.trim();
  if (!provider || provider.length > LIMITS.PROVIDER_ID_MAX_CHARS || !PROVIDER_ID_RE.test(provider)) return null;
  if (!isPlainObject(raw)) return null;

  const out = { provider };

  if (typeof raw.displayName === "string" && raw.displayName.trim().length > 0) {
    out.displayName = raw.displayName.trim().slice(0, LIMITS.PROVIDER_DISPLAY_NAME_MAX_CHARS);
  }

  if (raw.baseUrl !== undefined && raw.baseUrl !== null && raw.baseUrl !== "") {
    if (typeof raw.baseUrl !== "string") return null;
    const baseUrl = raw.baseUrl.trim();
    if (baseUrl.length === 0 || baseUrl.length > LIMITS.PROVIDER_BASE_URL_MAX_CHARS) return null;
    // 只允许 http(s)：这条同时挡住了 file:// / data: 这类会被喂给 fetch 的方案
    let parsed = null;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    out.baseUrl = baseUrl;
  }

  if (raw.api !== undefined && raw.api !== null && raw.api !== "") {
    if (typeof raw.api !== "string" || !PROVIDER_API_IDS.includes(raw.api)) return null;
    out.api = raw.api;
  }

  if (raw.models !== undefined && raw.models !== null) {
    if (!Array.isArray(raw.models)) return null;
    if (raw.models.length > LIMITS.PROVIDER_MODELS_MAX) return null;
    const models = [];
    const seen = new Set();
    for (const m of raw.models) {
      const normalized = normalizeProviderModel(m);
      if (!normalized) return null;
      if (seen.has(normalized.id)) return null; // 重复 id 直接判非法，不静默去重
      seen.add(normalized.id);
      models.push(normalized);
    }
    out.models = models;
  } else if (raw.models === null) {
    // 显式 `models: null` = 「这个定义**不带**模型目录覆盖」。
    // 用途：不带其它字段一起提交时，可以单独把「自定义模型目录」摘掉
    //（`set()` 是整条替换语义，所以需要这个明确的"我不改这一项"标记）。
    out.models = null;
  }

  // 空定义没有意义：至少要改点什么
  if (out.displayName === undefined && out.baseUrl === undefined && out.api === undefined && out.models === undefined) {
    return null;
  }
  return out;
}

/**
 * 整份存储的归一化。**坏条目丢弃、其余保留**（一个坏 id 不该废掉整份配置）。
 * @param {unknown} raw
 * @returns {{ version: number, providers: Record<string, object> }}
 */
export function normalizeProvidersDoc(raw) {
  const out = { version: PROVIDERS_VERSION, providers: Object.create(null) };
  if (!isPlainObject(raw)) return out;
  const src = isPlainObject(raw.providers) ? raw.providers : null;
  if (!src) return out;
  for (const [id, def] of Object.entries(src)) {
    const normalized = normalizeProviderDefinition(id, def);
    if (normalized) out.providers[normalized.provider] = normalized;
  }
  return out;
}

/**
 * `~/.minipi/providers.json` 的读写。
 *
 * 与 `SettingsStore` 同款三条硬约束：白名单归一化、原子落盘（`.tmp` → `rename`）、
 * 坏文件兜底（备份 `.bad` 后用空配置启动，绝不让 App 因为一个坏文件起不来）。
 */
export class ProviderStore {
  /**
   * @param {{ filePath?: string, logger?: {warn?:Function} }} [options]
   */
  constructor(options = {}) {
    this.filePath = options.filePath ?? PROVIDERS_PATH;
    this._logger = options.logger ?? console;
    /** @type {{version:number, providers:Record<string,object>}} */
    this._data = normalizeProvidersDoc(null);
    /** @type {string[]} load() 期间产生的告警 */
    this.warnings = [];
  }

  /** 当前定义（浅拷贝，避免调用方改到内部状态）。 */
  get() {
    return { ...this._data.providers };
  }

  /** 某个 id 的定义；没有则 undefined。 */
  getOne(providerId) {
    return this._data.providers[providerId];
  }

  /** 已被 minipi 定义了覆盖/自定义的全部 id。 */
  ids() {
    return Object.keys(this._data.providers);
  }

  /** 从磁盘加载；坏文件不致命。 */
  load() {
    this.warnings = [];
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT") {
        this._data = normalizeProvidersDoc(null);
        return this.get();
      }
      // 坏 JSON：备份后从空配置起步（与 settings.js 同款兜底）
      this.warnings.push(`providers.json 读取失败，已回退为空配置：${err?.message ?? err}`);
      try {
        fs.renameSync(this.filePath, `${this.filePath}.bad`);
      } catch {
        /* 备份失败不致命 */
      }
      this._data = normalizeProvidersDoc(null);
      return this.get();
    }
    this._data = normalizeProvidersDoc(raw);
    const dropped = Object.keys(isPlainObject(raw?.providers) ? raw.providers : {}).filter(
      (id) => !this._data.providers[id],
    );
    if (dropped.length > 0) {
      this.warnings.push(`providers.json 里有 ${dropped.length} 条非法定义已丢弃：${dropped.join(", ")}`);
    }
    return this.get();
  }

  /**
   * 写入/更新一个提供方定义。
   * @param {string} providerId
   * @param {unknown} definition
   * @throws {Error} 定义非法
   */
  set(providerId, definition) {
    const normalized = normalizeProviderDefinition(providerId, definition);
    if (!normalized) throw new Error("提供方定义非法");
    // `models: null` 是「不带模型目录覆盖」的显式标记，落盘前摘掉这个键
    // （落盘里 `models` 缺席 = 沿用提供方默认目录）。
    if (normalized.models === null) delete normalized.models;
    const next = normalizeProvidersDoc({ version: PROVIDERS_VERSION, providers: { ...this._data.providers, [providerId]: normalized } });
    this._data = next;
    this._write();
    return normalized;
  }

  /**
   * 删除一个提供方定义。
   * @param {string} providerId
   * @returns {boolean} 是否真的删掉了
   */
  remove(providerId) {
    if (!this._data.providers[providerId]) return false;
    const rest = { ...this._data.providers };
    delete rest[providerId];
    this._data = normalizeProvidersDoc({ version: PROVIDERS_VERSION, providers: rest });
    this._write();
    return true;
  }

  /** 原子落盘。 */
  _write() {
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(this._data, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      this._logger.warn?.(`[minipi:providers] 落盘失败：${err?.message ?? err}`);
      throw err;
    }
  }
}
