import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function isCredential(value) {
  return value && typeof value === "object" && typeof value.type === "string";
}

export class MinipiCredentialStore {
  constructor({ filePath = path.join(os.homedir(), ".minipi", "credentials.json"), fallbackRead } = {}) {
    this.filePath = filePath;
    this.fallbackRead = typeof fallbackRead === "function" ? fallbackRead : null;
  }

  async _readAll() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  async read(providerId, options) {
    options?.signal?.throwIfAborted();
    const own = (await this._readAll())[providerId];
    if (isCredential(own)) return own;
    if (this.fallbackRead) return (await this.fallbackRead(providerId, options)) ?? undefined;
    return undefined;
  }

  async list(options) {
    const data = await this._readAll();
    return Object.entries(data)
      .filter(([, value]) => isCredential(value))
      .map(([providerId, value]) => ({ providerId, type: value.type }));
  }

  async modify(providerId, fn, options) {
    options?.signal?.throwIfAborted();
    const data = await this._readAll();
    const current = isCredential(data[providerId]) ? data[providerId] : await this.fallbackRead?.(providerId, options);
    const next = await fn(current);
    if (next === undefined) delete data[providerId];
    else data[providerId] = next;
    await this._write(data);
    return next;
  }

  async delete(providerId, options) {
    await this.modify(providerId, () => undefined, options);
  }

  async _write(data) {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, this.filePath);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }
}
