import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { remoteAgentsHome } from "./app-home.mjs";

const ROOT = join(remoteAgentsHome(), "attachments");
const MAX_FILES = 4;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STORAGE_BYTES = 256 * 1024 * 1024;
const indexCache = new Map(); // absolute root -> { version, byDigest }

const FORMATS = [
  { mimeType: "image/png", ext: "png", matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { mimeType: "image/jpeg", ext: "jpg", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: "image/gif", ext: "gif", matches: (b) => b.length >= 6 && (b.subarray(0, 6).toString("ascii") === "GIF87a" || b.subarray(0, 6).toString("ascii") === "GIF89a") },
  { mimeType: "image/webp", ext: "webp", matches: (b) => b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
];

function fail(message, status = 400, code = "invalid_attachment") {
  throw Object.assign(new Error(message), { status, code });
}

function formatOf(buffer) {
  return FORMATS.find((format) => format.matches(buffer)) ?? null;
}

function formatForId(id) {
  const ext = String(id).split(".").at(-1)?.toLowerCase();
  return FORMATS.find((format) => format.ext === ext) ?? null;
}

function cleanName(name, ext) {
  const raw = basename(String(name || `image.${ext}`)).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 100);
  return raw || `image.${ext}`;
}

function attachmentIndexFile(root) {
  return join(root, ".index.json");
}

function writeAttachmentIndex(root, index) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = attachmentIndexFile(root);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
  renameSync(tmp, file);
}

function attachmentFiles(root) {
  let names;

  try { names = readdirSync(root); } catch { return []; }

  return names
    .filter((name) => /^[a-z0-9-]+\.(png|jpg|gif|webp)$/.test(name) && basename(name) === name)
    .map((name) => {
      const path = join(root, name);
      try { return { name, path, stat: statSync(path) }; } catch { return null; }
    })
    .filter(Boolean);
}

function loadAttachmentIndex(root) {
  const safeRoot = resolve(root);
  const cached = indexCache.get(safeRoot);

  if (cached) { return cached; }

  let parsed;

  try { parsed = JSON.parse(readFileSync(attachmentIndexFile(safeRoot), "utf8")); } catch {}

  if (parsed?.version === 1 && parsed.byDigest && typeof parsed.byDigest === "object" && !Array.isArray(parsed.byDigest)) {
    indexCache.set(safeRoot, parsed);
    return parsed;
  }

  // One-time migration for attachments created before the content-addressed
  // index existed. Files are read one at a time, bounded by the existing 256 MB
  // store cap; every later transcript lookup is O(1).
  const index = { version: 1, byDigest: {} };

  for (const entry of attachmentFiles(safeRoot).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)) {
    try {
      const buffer = readFileSync(entry.path);
      const format = formatOf(buffer);
      if (!format) { continue; }
      const digest = createHash("sha256").update(buffer).digest("hex");
      index.byDigest[digest] = { id: entry.name, name: `image.${format.ext}`, mimeType: format.mimeType };
    } catch {}
  }

  indexCache.set(safeRoot, index);
  try { writeAttachmentIndex(safeRoot, index); } catch {}
  return index;
}

export function pruneAttachments(now = Date.now(), root = ROOT) {
  const files = attachmentFiles(root);
  if (!files.length) { return; }
  const removed = new Set();

  for (const entry of files) {
    try {
      if (now - entry.stat.mtimeMs > RETAIN_MS) {
        unlinkSync(entry.path);
        removed.add(entry.name);
      }
    } catch {}
  }

  if (removed.size) {
    const index = loadAttachmentIndex(root);
    for (const [digest, entry] of Object.entries(index.byDigest)) {
      if (removed.has(entry?.id)) { delete index.byDigest[digest]; }
    }
    try { writeAttachmentIndex(resolve(root), index); } catch {}
  }
}

export function storeAttachment({ data, name } = {}, { root = ROOT, maxStorageBytes = MAX_STORAGE_BYTES } = {}) {
  if (typeof data !== "string" || !data) { fail("image data required"); }

  let buffer;

  try { buffer = Buffer.from(data, "base64"); } catch { fail("invalid base64 image"); }

  if (!buffer.length || buffer.toString("base64").replace(/=+$/, "") !== data.replace(/\s+/g, "").replace(/=+$/, "")) {
    fail("invalid base64 image");
  }

  if (buffer.length > MAX_FILE_BYTES) { fail("image is larger than 3 MB after compression", 413, "attachment_too_large"); }

  const format = formatOf(buffer);

  if (!format) { fail("use a PNG, JPEG, GIF, or WebP image", 415, "unsupported_image_type"); }

  mkdirSync(root, { recursive: true, mode: 0o700 });
  pruneAttachments(Date.now(), root);
  let storedBytes = 0;

  try {
    for (const entry of attachmentFiles(root)) { storedBytes += entry.stat.size; }
  } catch {}

  if (storedBytes + buffer.length > maxStorageBytes) {
    fail("image storage is full; remove old attachments or wait for expiry", 507, "attachment_storage_full");
  }

  const id = `${Date.now().toString(36)}-${randomBytes(10).toString("hex")}.${format.ext}`;
  const path = join(root, id);
  const storedName = cleanName(name, format.ext);
  writeFileSync(path, buffer, { mode: 0o600, flag: "wx" });

  const index = loadAttachmentIndex(root);
  const digest = createHash("sha256").update(buffer).digest("hex");
  const previous = index.byDigest[digest];
  index.byDigest[digest] = { id, name: storedName, mimeType: format.mimeType };

  try {
    writeAttachmentIndex(resolve(root), index);
  } catch {
    if (previous) { index.byDigest[digest] = previous; } else { delete index.byDigest[digest]; }
    try { unlinkSync(path); } catch {}
    fail("could not save the image index; attach it again", 500, "attachment_index_failed");
  }

  return { id, name: storedName, mimeType: format.mimeType, size: buffer.length };
}

export function resolveAttachmentIds(ids = [], { root = ROOT } = {}) {
  if (!Array.isArray(ids)) { fail("attachments must be an array"); }
  if (ids.length > MAX_FILES) { fail(`attach at most ${MAX_FILES} images`, 400, "too_many_attachments"); }

  let total = 0;
  const seen = new Set();
  const out = [];

  for (const raw of ids) {
    const id = String(raw ?? "");

    if (!/^[a-z0-9-]+\.(png|jpg|gif|webp)$/.test(id) || basename(id) !== id || seen.has(id)) {
      fail("invalid attachment reference");
    }

    seen.add(id);
    const format = formatForId(id);
    const path = join(root, id);

    if (!format || !existsSync(path)) { fail("an attached image expired; attach it again", 410, "attachment_expired"); }

    const size = statSync(path).size;
    total += size;

    if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
      fail("attached images exceed the 8 MB total limit", 413, "attachment_too_large");
    }

    out.push({ id, path, mimeType: format.mimeType, size });
  }

  return out;
}

export function readAttachment(id, { root = ROOT } = {}) {
  const [attachment] = resolveAttachmentIds([id], { root });
  return { ...attachment, data: readFileSync(attachment.path) };
}

// Provider transcripts preserve the image bytes/path but not the bridge's
// opaque attachment id. Recover that id only when the image is one we stored;
// arbitrary local paths remain inaccessible to the browser.
export function storedAttachmentForPath(rawPath, { root = ROOT } = {}) {
  if (typeof rawPath !== "string" || !rawPath) { return null; }

  const absolute = resolve(rawPath);
  const safeRoot = resolve(root);

  if (dirname(absolute) !== safeRoot) { return null; }

  const id = basename(absolute);

  try {
    const [attachment] = resolveAttachmentIds([id], { root: safeRoot });
    const indexed = Object.values(loadAttachmentIndex(safeRoot).byDigest).find((entry) => entry?.id === id);
    return { id: attachment.id, name: indexed?.name || `image.${formatForId(id)?.ext || "png"}`, mimeType: attachment.mimeType };
  } catch {
    return null;
  }
}

export function storedAttachmentForBase64(data, { root = ROOT } = {}) {
  if (typeof data !== "string" || !data) { return null; }

  let buffer;

  try { buffer = Buffer.from(data, "base64"); } catch { return null; }
  if (!buffer.length) { return null; }

  const digest = createHash("sha256").update(buffer).digest("hex");
  const entry = loadAttachmentIndex(root).byDigest[digest];

  if (!entry?.id) { return null; }

  const matched = storedAttachmentForPath(join(resolve(root), entry.id), { root });
  return matched ? { ...matched, name: entry.name || matched.name } : null;
}

export const attachmentLimits = { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxStorageBytes: MAX_STORAGE_BYTES };
