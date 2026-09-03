import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_STORAGE_DIR = "/tmp/alterego-telegram-publisher-media";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TTL_SECONDS = 60 * 60;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const MEDIA_FILE_PATTERN = /^[a-f0-9]{48}\.(?:jpg|png|webp)$/;
const UPLOAD_SOURCE_PREFIX = "mcp-upload:";

const MEDIA_TYPES = {
  "image/jpeg": {
    extension: "jpg",
    matches: (buffer) =>
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff,
  },
  "image/png": {
    extension: "png",
    matches: (buffer) =>
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  },
  "image/webp": {
    extension: "webp",
    matches: (buffer) =>
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP",
  },
};

function positiveInteger(rawValue, fallback, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallback;
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function parsePublicBaseUrl(env) {
  const rawValue = env.MEDIA_PUBLIC_BASE_URL?.trim();
  if (!rawValue) return null;

  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error("MEDIA_PUBLIC_BASE_URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("MEDIA_PUBLIC_BASE_URL must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("MEDIA_PUBLIC_BASE_URL cannot contain credentials, a query, or a fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/media";
  return url;
}

function decodeBase64(contentBase64, maxBytes) {
  const compact = contentBase64.replace(/\s+/g, "");
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error("contentBase64 must contain valid standard base64 without a data-URL prefix.");
  }
  if (compact.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Error(`The uploaded image exceeds the ${maxBytes}-byte limit.`);
  }

  const buffer = Buffer.from(compact, "base64");
  if (!buffer.length || buffer.length > maxBytes) {
    throw new Error(`The uploaded image must contain 1-${maxBytes} bytes.`);
  }
  return buffer;
}

function contentTypeForFilename(filename) {
  if (filename.endsWith(".jpg")) return "image/jpeg";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".webp")) return "image/webp";
  return null;
}

export function mediaConfig(env = process.env) {
  return {
    publicBaseUrl: parsePublicBaseUrl(env),
    storageDir: resolve(env.MEDIA_STORAGE_DIR?.trim() || DEFAULT_STORAGE_DIR),
    maxBytes: positiveInteger(env.MEDIA_MAX_BYTES, DEFAULT_MAX_BYTES, "MEDIA_MAX_BYTES", {
      min: 1024,
      max: 20 * 1024 * 1024,
    }),
    ttlSeconds: positiveInteger(
      env.MEDIA_TTL_SECONDS,
      DEFAULT_TTL_SECONDS,
      "MEDIA_TTL_SECONDS",
      { min: 60, max: 7 * 24 * 60 * 60 },
    ),
  };
}

export class TemporaryMediaStore {
  constructor(env = process.env, options = {}) {
    this.config = mediaConfig(env);
    this.now = options.now ?? (() => Date.now());
    this.activeLeases = new Map();
    this.cleanupTimer = null;
  }

  startCleanupTimer() {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired().catch((error) => {
        console.error("Temporary media cleanup failed", error);
      });
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
    this.cleanupExpired().catch((error) => {
      console.error("Initial temporary media cleanup failed", error);
    });
  }

  stopCleanupTimer() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  filePath(filename) {
    if (!MEDIA_FILE_PATTERN.test(filename)) throw new Error("Invalid temporary media id.");
    return resolve(this.config.storageDir, filename);
  }

  sourceToFilename(source) {
    if (typeof source !== "string") return null;
    if (source.startsWith(UPLOAD_SOURCE_PREFIX)) {
      const filename = source.slice(UPLOAD_SOURCE_PREFIX.length);
      return MEDIA_FILE_PATTERN.test(filename) ? filename : null;
    }

    // Accept URLs produced by v1.4 so a rolling deployment does not invalidate
    // an image uploaded immediately before the server was upgraded.
    const publicBaseUrl = this.config.publicBaseUrl;
    if (!publicBaseUrl) return null;

    let url;
    try {
      url = new URL(source);
    } catch {
      return null;
    }
    const basePath = publicBaseUrl.pathname.replace(/\/+$/, "");
    const prefix = `${basePath}/`;
    if (
      url.origin !== publicBaseUrl.origin ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith(prefix)
    ) {
      return null;
    }
    const filename = url.pathname.slice(prefix.length);
    return MEDIA_FILE_PATTERN.test(filename) ? filename : null;
  }

  async upload({ contentBase64, mimeType }) {
    const mediaType = MEDIA_TYPES[mimeType];
    if (!mediaType) throw new Error("mimeType must be image/jpeg, image/png, or image/webp.");

    const buffer = decodeBase64(contentBase64, this.config.maxBytes);
    if (!mediaType.matches(buffer)) {
      throw new Error(`The file signature does not match ${mimeType}.`);
    }

    await mkdir(this.config.storageDir, { recursive: true, mode: 0o700 });
    const filename = `${randomBytes(24).toString("hex")}.${mediaType.extension}`;
    await writeFile(this.filePath(filename), buffer, { flag: "wx", mode: 0o600 });

    const source = `${UPLOAD_SOURCE_PREFIX}${filename}`;
    return {
      source,
      mimeType,
      sizeBytes: buffer.length,
      expiresAt: new Date(this.now() + this.config.ttlSeconds * 1000).toISOString(),
    };
  }

  async acquireSources(sources) {
    const filenames = [
      ...new Set(sources.map((source) => this.sourceToFilename(source)).filter(Boolean)),
    ];
    for (const filename of filenames) {
      try {
        await stat(this.filePath(filename));
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new Error(
            `Temporary image ${filename} is no longer available. Upload it again and repeat the preview.`,
          );
        }
        throw error;
      }
    }
    for (const filename of filenames) {
      this.activeLeases.set(filename, (this.activeLeases.get(filename) ?? 0) + 1);
    }
    return filenames;
  }

  async readSources(sources) {
    const localMedia = new Map();
    for (const source of new Set(sources)) {
      const filename = this.sourceToFilename(source);
      if (!filename) continue;
      const mimeType = contentTypeForFilename(filename);
      localMedia.set(source, {
        filename,
        mimeType,
        data: await readFile(this.filePath(filename)),
      });
    }
    return localMedia;
  }

  async releaseSources(filenames, { remove = false } = {}) {
    let removed = 0;
    for (const filename of filenames) {
      const nextCount = Math.max((this.activeLeases.get(filename) ?? 1) - 1, 0);
      if (nextCount) {
        this.activeLeases.set(filename, nextCount);
        continue;
      }
      this.activeLeases.delete(filename);
      if (remove && (await this.removeFile(filename))) removed += 1;
    }
    return removed;
  }

  async removeFile(filename) {
    try {
      await unlink(this.filePath(filename));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async cleanupExpired() {
    let entries;
    try {
      entries = await readdir(this.config.storageDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }

    const cutoff = this.now() - this.config.ttlSeconds * 1000;
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !MEDIA_FILE_PATTERN.test(entry.name)) continue;
      if (this.activeLeases.has(entry.name)) continue;
      const details = await stat(this.filePath(entry.name));
      if (details.mtimeMs <= cutoff && (await this.removeFile(entry.name))) removed += 1;
    }
    return removed;
  }

  async handleHttpRequest(req, res, url) {
    const publicBaseUrl = this.config.publicBaseUrl;
    if (!publicBaseUrl || !new Set(["GET", "HEAD"]).has(req.method)) return false;
    const prefix = `${publicBaseUrl.pathname.replace(/\/+$/, "")}/`;
    if (!url.pathname.startsWith(prefix)) return false;

    const filename = url.pathname.slice(prefix.length);
    const contentType = contentTypeForFilename(filename);
    if (!contentType || !MEDIA_FILE_PATTERN.test(filename)) {
      res.writeHead(404).end("Not Found");
      return true;
    }

    let details;
    try {
      details = await stat(this.filePath(filename));
    } catch (error) {
      if (error?.code === "ENOENT") {
        res.writeHead(404).end("Not Found");
        return true;
      }
      throw error;
    }

    if (
      details.mtimeMs <= this.now() - this.config.ttlSeconds * 1000 &&
      !this.activeLeases.has(filename)
    ) {
      await this.removeFile(filename);
      res.writeHead(410).end("Gone");
      return true;
    }

    res.writeHead(200, {
      "content-type": contentType,
      "content-length": details.size,
      "cache-control": "private, max-age=60",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }

    const stream = createReadStream(this.filePath(filename));
    stream.on("error", (error) => {
      console.error("Temporary media response failed", error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.pipe(res);
    return true;
  }
}

export function createTemporaryMediaStore(env = process.env, options = {}) {
  return new TemporaryMediaStore(env, options);
}

export {
  DEFAULT_MAX_BYTES,
  DEFAULT_STORAGE_DIR,
  DEFAULT_TTL_SECONDS,
  MEDIA_FILE_PATTERN,
  UPLOAD_SOURCE_PREFIX,
};
