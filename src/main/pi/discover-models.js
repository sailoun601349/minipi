/**
 * 「获取可用模型」—— 向提供方的 **模型清单端点**发一次 GET，把可用模型列出来。
 *
 * ## 为什么自己实现，而不是用 Pi 的 `runtime.refresh()`
 *
 * `ModelRuntime.refresh({ allowNetwork, providers, force })` 是「刷新提供方自己的模型目录」，
 * 它依赖该 provider 注册时带了 `refreshModels()` 实现，而且**会把结果落进 Pi 的目录缓存**。
 * minipi 需要的语义不一样：用户点一下 → 拿到一份**候选清单** → 自己勾选哪几条加进目录
 * → 再保存。这是一次性的、只读的、不回写 Pi 缓存的动作，所以单独实现更可控。
 *
 * ## 支持范围（明确写出来，避免"点了一下没反应"）
 *
 * | 协议 | 清单端点 | 认证头 |
 * |---|---|---|
 * | `openai-completions` / `openai-responses` | `{baseUrl}/models` | `Authorization: Bearer <key>` |
 * | `anthropic-messages` | `{baseUrl}/v1/models` | `x-api-key: <key>` + `anthropic-version` |
 * | `google-generative-ai` | **不支持** | —— |
 *
 * 不支持的协议**显式报错**（`DISCOVER_FAILED` + 可读原因），不是静默返回空数组 ——
 * 「空数组」和「拉不到」在界面上长得一样，但一个让人以为「提供方没有模型」。
 *
 * ## 安全
 *
 * · 密钥**只出现在请求头**，绝不进返回值、不进错误文案、不进日志；
 * · 硬超时（`LIMITS.DISCOVER_MODELS_TIMEOUT_MS`）+ 响应体大小上限；
 * · 只 GET，不改任何远端状态。
 *
 * 本文件不 import Pi SDK / electron，可在纯 Node 下测试（注入 `fetchImpl`）。
 */

import { ERROR_CODES, LIMITS, errorMessage } from "../../shared/protocol.js";

/** Anthropic 的清单端点要求这个头；值取当前稳定版。`[待核实: 版本号如失效，改这一处]` */
const ANTHROPIC_VERSION = "2023-06-01";

/** 支持「拉清单」的协议。 */
export const LISTABLE_PROTOCOLS = Object.freeze(["openai-completions", "openai-responses", "anthropic-messages"]);

/**
 * 拼清单端点 URL。**纯函数**。
 * @param {string} baseUrl
 * @param {string} api
 * @returns {string}
 * @throws {Error} 协议不支持 / URL 非法
 */
export function listingUrl(baseUrl, api) {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    throw new Error(errorMessage(ERROR_CODES.DISCOVER_FAILED, "需要先填 API 地址才能获取模型"));
  }
  if (!LISTABLE_PROTOCOLS.includes(api)) {
    throw new Error(
      errorMessage(
        ERROR_CODES.DISCOVER_FAILED,
        `协议 ${api || "(空)"} 不支持自动获取模型，请手动添加模型条目`,
      ),
    );
  }
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/models$/.test(trimmed)) return trimmed;
  if (api === "anthropic-messages") {
    // baseUrl 可能是 https://api.anthropic.com 或 .../v1 两种写法，都收敛到 /v1/models
    return /\/v1$/.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
  }
  return `${trimmed}/models`;
}

/**
 * 解析清单响应。**纯函数**，对三家常见形状都宽容，但**不接受非数组的 data**。
 *
 * 认得：
 *   · OpenAI / 兼容网关：`{ object:"list", data:[{ id, ... }] }`
 *   · Anthropic：`{ data:[{ id, display_name }] }`
 *   · 部分网关：`{ models:[...] }`；裸数组 `[...]`
 *
 * @param {unknown} body
 * @returns {Array<{ modelId: string, name: string }>}
 * @throws {Error} 结构不认识
 */
export function parseModelListing(body) {
  const arr = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : null;
  if (!arr) {
    throw new Error(errorMessage(ERROR_CODES.DISCOVER_FAILED, "提供方返回的不是模型清单（找不到 data/models 数组）"));
  }
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (out.length >= LIMITS.DISCOVER_MODELS_MAX) break;
    // 有的网关把条目写成字符串
    const id =
      typeof item === "string"
        ? item.trim()
        : typeof item?.id === "string"
          ? item.id.trim()
          : typeof item?.model === "string"
            ? item.model.trim()
            : "";
    if (!id || seen.has(id) || id.length > LIMITS.PROVIDER_MODEL_ID_MAX_CHARS) continue;
    seen.add(id);
    const rawName = typeof item?.display_name === "string" ? item.display_name : item?.name;
    const name = typeof rawName === "string" && rawName.trim().length > 0
      ? rawName.trim().slice(0, LIMITS.PROVIDER_MODEL_NAME_MAX_CHARS)
      : id;
    out.push({ modelId: id, name });
  }
  if (out.length === 0) {
    throw new Error(errorMessage(ERROR_CODES.DISCOVER_FAILED, "提供方返回的模型清单是空的"));
  }
  return out;
}

/**
 * 拉一次模型清单。
 *
 * @param {object} input
 * @param {string} input.baseUrl 提供方 API 地址
 * @param {string} [input.api] 协议（默认 openai-completions）
 * @param {string} [input.apiKey] 密钥；只在请求头里用，绝不回传
 * @param {number} [input.timeoutMs]
 * @param {typeof fetch} [input.fetchImpl] 便于测试注入
 * @returns {Promise<{ models: Array<{modelId:string,name:string}>, url: string, protocol: string }>}
 * @throws {Error} DISCOVER_FAILED
 */
export async function discoverModels(input = {}) {
  const api = typeof input.api === "string" && input.api.length > 0 ? input.api : "openai-completions";
  const url = listingUrl(input.baseUrl, api); // 抛错也带 DISCOVER_FAILED
  const timeoutMs =
    Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : LIMITS.DISCOVER_MODELS_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const apiKey = typeof input.apiKey === "string" ? input.apiKey : "";

  /** @type {Record<string,string>} */
  const headers = { accept: "application/json" };
  if (apiKey) {
    if (api === "anthropic-messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = ANTHROPIC_VERSION;
    } else {
      headers.authorization = `Bearer ${apiKey}`;
    }
  }

  let res;
  try {
    res = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // ⚠ 这里**只透出错误类型**，不透出 err.stack / 请求头（可能含 key）
    const reason = err?.name === "TimeoutError" ? `超时（${timeoutMs}ms）` : err?.code ?? err?.name ?? "网络错误";
    throw new Error(errorMessage(ERROR_CODES.DISCOVER_FAILED, `请求失败：${reason}`));
  }

  if (!res.ok) {
    throw new Error(errorMessage(ERROR_CODES.DISCOVER_FAILED, `提供方返回 HTTP ${res.status}`));
  }

  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw new Error(errorMessage(ERROR_CODES.DISCOVER_FAILED, `读取响应失败：${err?.name ?? "未知"}`));
  }
  if (text.length > LIMITS.DISCOVER_MODELS_MAX_BYTES) {
    throw new Error(errorMessage(ERROR_CODES.DISCOVER_FAILED, "响应过大，已拒绝解析"));
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(errorMessage(ERROR_CODES.DISCOVER_FAILED, "响应不是 JSON"));
  }

  return { models: parseModelListing(body), url, protocol: api };
}
