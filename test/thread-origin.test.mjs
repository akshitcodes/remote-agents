import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { codexOrigin } from "../codex-rollout.mjs";
import { claudeOrigin } from "../providers/claude.mjs";
import { MAX_ORIGIN_RECORDS, ThreadOrigins } from "../thread-origins.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

test("codex sessions classify from the CLI's own recorded facts", () => {
  // Structural markers written by codex itself.
  assert.equal(codexOrigin({ originator: "Codex Desktop" }, "subagent"), "agent");
  assert.equal(codexOrigin({ originator: "codex_exec", source: "exec" }, "user"), "agent");
  assert.equal(codexOrigin({ originator: "Codex Desktop", source: "exec" }, "user"), "agent");
  // Our own clientInfo stamp.
  assert.equal(codexOrigin({ originator: "codex-phone", source: "vscode" }, "user"), "ui");
  assert.equal(codexOrigin({ originator: "codex-phone-thread", source: "vscode" }, "user"), "ui");
  // The app and CLI the user actually types into.
  assert.equal(codexOrigin({ originator: "Codex Desktop", source: "vscode" }, "user"), "native");
  assert.equal(codexOrigin({ originator: "codex-tui", source: "cli" }, "user"), "native");
});

test("an unclassifiable codex session is shown, never hidden", () => {
  assert.equal(codexOrigin({}, "user"), "native");
  assert.equal(codexOrigin(null, undefined), "native");
  assert.equal(codexOrigin({ originator: "some-future-client" }, "user"), "native");
});

test("claude agent sessions classify from sidechain, agent-name, and mktemp cwds", () => {
  assert.equal(claudeOrigin({ sidechain: true }), "agent");
  assert.equal(claudeOrigin({ agentName: true }), "agent");
  assert.equal(claudeOrigin({ cwd: "/private/var/folders/02/x/T/steer-http-abc" }), "agent");
  assert.equal(claudeOrigin({ cwd: "/var/folders/02/x/T/harness" }), "agent");
  assert.equal(claudeOrigin({ cwd: "/tmp/scratch" }), "agent");
  // Real project folders — including ones merely containing "tmp" — are native.
  assert.equal(claudeOrigin({ cwd: "/Users/dev/code/project" }), "native");
  assert.equal(claudeOrigin({ cwd: "/Users/dev/tmp-notes" }), "native");
  assert.equal(claudeOrigin({}), "native");
});

function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), "codex-phone-origins-")), "origins.json");
  return { file, origins: new ThreadOrigins({ file }) };
}

test("UI-created sessions are stamped durably and follow a draft onto its real id", () => {
  const { file, origins } = fixture();
  origins.markUi("claude", "draft-abc123");
  assert.equal(origins.isUi("claude", "draft-abc123"), true);

  origins.adopt("claude", "draft-abc123", "real-session-id");
  assert.equal(origins.isUi("claude", "draft-abc123"), false);
  assert.equal(origins.isUi("claude", "real-session-id"), true);

  const restarted = new ThreadOrigins({ file });
  assert.equal(restarted.isUi("claude", "real-session-id"), true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
});

test("adopting an unmarked draft stamps nothing", () => {
  const { origins } = fixture();
  origins.adopt("claude", "draft-native", "native-session");
  assert.equal(origins.isUi("claude", "native-session"), false);
});

test("the ledger is bounded, dropping oldest first — which only ever shows more", () => {
  const { origins } = fixture();
  for (let index = 0; index < MAX_ORIGIN_RECORDS + 3; index += 1) {
    origins.markUi("codex", `t-${index}`);
  }
  assert.equal(origins.isUi("codex", "t-0"), false);
  assert.equal(origins.isUi("codex", `t-${MAX_ORIGIN_RECORDS + 2}`), true);
});

test("a damaged origin ledger never stops the bridge from starting", () => {
  const { file } = fixture();
  writeFileSync(file, "{ not json");
  assert.equal(new ThreadOrigins({ file }).isUi("codex", "x"), false);
});

test("the server filters agent sessions only when asked, and stars are exempt", () => {
  // Default stays "all" so an older shell that sends no origin parameter keeps
  // seeing exactly what it saw before this bridge upgrade.
  assert.match(server, /url\.searchParams\.get\("origin"\) !== "mine"/);
  assert.match(server, /function withoutAgentThreads\(rows, includeAgents\)/);
  assert.match(server, /thread\.origin === "agent" && !threadStars\.has\(thread\.provider, thread\.id\)/);
  // Recent filters per provider page *before* ranking, so featuredCount stays honest.
  assert.match(server, /const visibleGroups = groups\.map[\s\S]{0,200}withoutAgentThreads/);
  assert.match(server, /rankRecentThreads\(visibleGroups, \{ limit: 10 \}\)/);
  // Creation stamps the ledger; adoption carries it to the real session id.
  assert.match(server, /threadOrigins\.markUi\(p\.name, created\.thread\.id\)/);
  assert.match(server, /threadOrigins\.adopt\(name, data\.params\.threadId, data\.params\.sessionId\)/);
  // Ledger beats provider metadata; unmarked rows default to native.
  assert.match(server, /if \(threadOrigins\.isUi\(providerName, thread\.id\)\) \{ thread\.origin = "ui"; \}\s*\n\s*else if \(!thread\.origin\) \{ thread\.origin = "native"; \}/);
});

test("the UI hides agent sessions by default behind a checkmark that reports the count", () => {
  assert.match(html, /showAgentSessions: false,/);
  assert.match(html, /<label id="agentToggle"><input type="checkbox" id="agentToggleInput">/);
  assert.match(html, /q\.set\("origin", showAgents \? "all" : "mine"\);/);
  assert.match(html, /Show agent-made sessions \(\$\{state\.hiddenAgentCount\} hidden\)/);
  // The toggle is part of the request identity: stale responses and offline
  // caches from the other filter state must not paint this one.
  assert.match(html, /state\.showAgentSessions !== showAgents\) \{ return; \}/);
  assert.match(html, /listCacheKey\(`\$\{listView\}:\$\{providerScope\}:\$\{showAgents \? "all" : "mine"\}`\)/);
  // Visible agent-made rows are labelled.
  assert.match(html, /class="chip origin-badge"/);
  assert.match(html, /showAgentSessions: state\.showAgentSessions,/);
});
