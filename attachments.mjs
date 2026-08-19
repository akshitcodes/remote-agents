import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { remoteAgentsHome } from "./app-home.mjs";

const ROOT = join(remoteAgentsHome(), "attachments");
const MAX_FILES = 4;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STORAGE_BYTES = 256 * 1024 * 1024;

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

export function pruneAttachments(now = Date.now(), root = ROOT) {
  let names = [];

  try { names = readdirSync(root); } catch { return; }

  for (const name of names) {
    const file = join(root, basename(name));

    try {
      if (now - statSync(file).mtimeMs > RETAIN_MS) { unlinkSync(file); }
    } catch {}
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
    for (const entry of readdirSync(root)) {
      try { storedBytes += statSync(join(root, basename(entry))).size; } catch {}
    }
  } catch {}

  if (storedBytes + buffer.length > maxStorageBytes) {
    fail("image storage is full; remove old attachments or wait for expiry", 507, "attachment_storage_full");
  }

  const id = `${Date.now().toString(36)}-${randomBytes(10).toString("hex")}.${format.ext}`;
  const path = join(root, id);
  writeFileSync(path, buffer, { mode: 0o600, flag: "wx" });

  return { id, name: cleanName(name, format.ext), mimeType: format.mimeType, size: buffer.length };
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

export const attachmentLimits = { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxStorageBytes: MAX_STORAGE_BYTES };
