import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pruneAttachments, readAttachment, resolveAttachmentIds, storeAttachment } from "../attachments.mjs";

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("uploaded image is magic-validated, stored privately, and resolvable by opaque id", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-phone-images-"));
  const stored = storeAttachment({ name: "screen shot.png", data: PNG_1PX.toString("base64") }, { root });
  const [resolved] = resolveAttachmentIds([stored.id], { root });
  const read = readAttachment(stored.id, { root });

  assert.equal(stored.mimeType, "image/png");
  assert.match(stored.id, /^[a-z0-9-]+\.png$/);
  assert.equal(resolved.path.startsWith(root + "/"), true);
  assert.deepEqual(read.data, PNG_1PX);
});

test("attachment references reject traversal, duplication, missing files, and non-images", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-phone-images-"));
  const stored = storeAttachment({ data: PNG_1PX.toString("base64") }, { root });

  assert.throws(() => resolveAttachmentIds(["../secret.png"], { root }), /invalid attachment reference/);
  assert.throws(() => resolveAttachmentIds([stored.id, stored.id], { root }), /invalid attachment reference/);
  assert.throws(() => resolveAttachmentIds(["missing.png"], { root }), (error) => error.status === 410 && error.code === "attachment_expired");
  assert.throws(() => storeAttachment({ data: Buffer.from("not an image").toString("base64") }, { root }), (error) => error.status === 415);
});

test("expired attachments are pruned without touching fresh files", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-phone-images-"));
  const old = join(root, "old.png");
  const fresh = join(root, "fresh.png");
  writeFileSync(old, PNG_1PX);
  writeFileSync(fresh, PNG_1PX);
  const now = Date.now();
  utimesSync(old, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));

  pruneAttachments(now, root);

  assert.throws(() => readFileSync(old));
  assert.deepEqual(readFileSync(fresh), PNG_1PX);
});

test("attachment storage has a hard total-byte ceiling", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-phone-images-"));
  storeAttachment({ data: PNG_1PX.toString("base64") }, { root, maxStorageBytes: PNG_1PX.length });

  assert.throws(
    () => storeAttachment({ data: PNG_1PX.toString("base64") }, { root, maxStorageBytes: PNG_1PX.length }),
    (error) => error.status === 507 && error.code === "attachment_storage_full",
  );
});
