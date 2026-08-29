import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { summarize } from "../codex-rollout.mjs";
import { groupCodexSummaries } from "../providers/codex.mjs";

test("Codex rollout summary preserves native subagent ownership metadata", () => {
  const path = join(mkdtempSync(join(tmpdir(), "codex-phone-rollout-")), "rollout-test.jsonl");
  writeFileSync(path, [
    JSON.stringify({ type: "session_meta", payload: { id: "child-unique-test", cwd: "/repo", source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1, agent_nickname: "Confucius", agent_path: "/root/reviewer" } } } } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Review this task" } }),
  ].join("\n"));

  const row = summarize({ path, mtimeMs: 2000 });
  assert.equal(row.threadSource, "subagent");
  assert.equal(row.parentThreadId, "parent");
  assert.equal(row.subagentDepth, 1);
  assert.equal(row.agentNickname, "Confucius");
  assert.equal(row.agentPath, "/root/reviewer");
  assert.equal(summarize({ path, mtimeMs: 9000 }).updatedAt, 9, "cached metadata must retain fresh mtime");
});

test("a thread created before its first prompt refreshes an initially empty preview", () => {
  const path = join(mkdtempSync(join(tmpdir(), "codex-phone-growing-")), "rollout-growing.jsonl");
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: "growing-unique-test", cwd: "/repo" } }) + "\n");
  assert.equal(summarize({ path, mtimeMs: 1000 }).preview, "");

  appendFileSync(path, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Now I have a title" } }) + "\n");
  assert.equal(summarize({ path, mtimeMs: 2000 }).preview, "Now I have a title");
});

test("children are grouped regardless of file order and are searchable from the parent", () => {
  const parent = { id: "parent", provider: "codex", name: "Main task", preview: "Build UI", cwd: "/repo", updatedAt: 5 };
  const child = { id: "child", provider: "codex", threadSource: "subagent", parentThreadId: "parent", agentNickname: "Confucius", agentPath: "/root/reviewer", updatedAt: 10 };
  const orphan = { id: "orphan", provider: "codex", threadSource: "subagent", parentThreadId: "missing", updatedAt: 20 };

  const grouped = groupCodexSummaries([parent, child, orphan]);
  assert.equal(grouped.data.length, 2, "a child with a missing parent remains visible");
  assert.deepEqual(grouped.data[0].subagents.map((row) => row.id), ["child"]);
  assert.equal(grouped.data[1].id, "orphan");
  assert.equal(groupCodexSummaries([parent, child], { search: "confucius" }).data[0].id, "parent");
  assert.equal(groupCodexSummaries([parent, child], { search: "reviewer" }).data[0].id, "parent");
});

test("nested descendants are flattened into the root task disclosure", () => {
  const parent = { id: "parent", provider: "codex", updatedAt: 1 };
  const child = { id: "child", provider: "codex", threadSource: "subagent", parentThreadId: "parent", updatedAt: 2 };
  const grandchild = { id: "grandchild", provider: "codex", threadSource: "subagent", parentThreadId: "child", updatedAt: 3 };
  assert.deepEqual(groupCodexSummaries([grandchild, parent, child]).data[0].subagents.map((row) => row.id), ["grandchild", "child"]);
});

test("group pagination counts parent tasks, not child rollouts", () => {
  const rows = Array.from({ length: 27 }, (_, index) => ({ id: `p-${index}`, provider: "codex", updatedAt: 100 - index }));
  rows.splice(1, 0, { id: "child", provider: "codex", threadSource: "subagent", parentThreadId: "p-0", updatedAt: 200 });
  const first = groupCodexSummaries(rows);
  assert.equal(first.data.length, 25);
  assert.equal(first.nextCursor, "25");
  assert.equal(groupCodexSummaries(rows, { offset: 25 }).data.length, 2);
  const complete = groupCodexSummaries(rows, { limit: null });
  assert.equal(complete.data.length, 27);
  assert.equal(complete.nextCursor, null);
});

test("an omitted HTTP search parameter does not become the literal query null", () => {
  const parent = { id: "parent", provider: "codex", name: "Visible task", updatedAt: 1 };
  assert.equal(groupCodexSummaries([parent], { search: null }).data.length, 1);
});
