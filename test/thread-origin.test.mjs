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
  // Every SDK/print-mode dispatch — an agent driving claude -p in a real
  // project folder — records an sdk entrypoint. Humans arrive as cli, vscode,
  // or desktop.
  assert.equal(claudeOrigin({ cwd: "/Users/dev/code/project", entrypoint: "sdk-cli" }), "agent");
  assert.equal(claudeOrigin({ cwd: "/Users/dev/code/project", entrypoint: "cli" }), "native");
  assert.equal(claudeOrigin({ cwd: "/Users/dev/code/project", entrypoint: "claude-vscode" }), "native");
  assert.equal(claudeOrigin({ cwd: "/Users/dev/code/project", entrypoint: "claude-desktop" }), "native");
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
  assert.match(server, /function visibleThreads\(rows, \{ includeAgents \}\)/);
  assert.match(server, /thread\.origin === "agent" && !threadStars\.has\(thread\.provider, thread\.id\)/);
  // Recent filters per provider page *before* ranking, so featuredCount stays honest.
  assert.match(server, /const visibleGroups = groups\.map[\s\S]{0,200}visibleThreads/);
  assert.match(server, /rankRecentThreads\(visibleGroups, \{ limit: 10 \}\)/);
  // Creation stamps the ledger; adoption carries it to the real session id.
  assert.match(server, /threadOrigins\.markUi\(p\.name, created\.thread\.id\)/);
  assert.match(server, /threadOrigins\.adopt\(name, data\.params\.threadId, data\.params\.sessionId\)/);
  // Ledger beats provider metadata; unmarked rows fall back to it.
  assert.match(server, /thread\.origin = threadOrigins\.isUi\(providerName, thread\.id\) \? "ui" : thread\.baseOrigin;/);
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

test("origin means creation or an explicit correction — never engagement", () => {
  // Exactly two ways a session becomes "mine": it was created here, or the
  // user said so. Steering or opening an agent's session from the phone is
  // neither, so the send ledger and thread-settings stay out of it.
  assert.equal((server.match(/threadOrigins\.markUi\(/g) ?? []).length, 2);
  assert.match(server, /threadOrigins\.markUi\(p\.name, created\.thread\.id\)/);
  assert.match(server, /threadOrigins\.markUi\(provider, threadId, \{ source: "manual"/);
  assert.doesNotMatch(server, /sendLedger[\s\S]{0,200}threadOrigins\.markUi/);
  assert.doesNotMatch(server, /threadSettingsStore[\s\S]{0,200}threadOrigins\.markUi/);
});

test("a misclassified session can be reclassified as mine, and undone", () => {
  const file = join(mkdtempSync(join(tmpdir(), "codex-phone-origins-mark-")), "origins.json");
  const origins = new ThreadOrigins({ file });

  origins.markUi("claude", "agentish", { source: "manual", title: "A review", cwd: "/Users/dev/code" });
  assert.equal(origins.isUi("claude", "agentish"), true);
  assert.deepEqual(origins.listManual().map((r) => r.threadId), ["agentish"]);
  assert.equal(origins.listManual()[0].title, "A review");
  assert.equal(new ThreadOrigins({ file }).isUi("claude", "agentish"), true);

  assert.equal(origins.clearUi("claude", "agentish"), true);
  assert.equal(origins.isUi("claude", "agentish"), false);
  assert.equal(origins.clearUi("claude", "agentish"), false);
});

test("only hand-made corrections are listed back, not every UI-created session", () => {
  const { origins } = fixture();
  origins.markUi("codex", "created-here");
  origins.markUi("codex", "corrected", { source: "manual" });

  assert.equal(origins.isUi("codex", "created-here"), true);
  assert.deepEqual(origins.listManual().map((r) => r.threadId), ["corrected"]);
});

test("a hand correction upgrades a creation stamp, never the reverse", () => {
  const { origins } = fixture();
  origins.markUi("codex", "t");
  origins.markUi("codex", "t", { source: "manual", title: "kept" });
  assert.deepEqual(origins.listManual().map((r) => r.threadId), ["t"]);

  // A later creation stamp must not silently strip the label the user chose.
  origins.markUi("codex", "t");
  assert.deepEqual(origins.listManual().map((r) => r.threadId), ["t"]);
});

test("reclassifying is reachable from the row menu and reversible in settings", () => {
  assert.match(server, /"POST \/api\/thread\/origin"/);
  assert.match(server, /if \(body\?\.mine === false\) \{ threadOrigins\.clearUi\(provider, threadId\); \}/);
  assert.match(server, /threadOrigins\.markUi\(provider, threadId, \{ source: "manual"/);
  // Offered only where it means something: a session the rules called agent,
  // or one already corrected.
  assert.match(html, /const canReclassify = targetRow\?\.origin === "agent" \|\| markedMine;/);
  assert.match(html, /\$\{markedMine \? "Classify as agent-made" : "Keep in my sessions"\}/);
  assert.match(html, /\[data-unmine\]/);
  assert.match(html, /\{ key: "mine", group: "App", title: "Kept as mine" \}/);
});

test("clearing an override actually takes effect on cached provider rows", () => {
  // Provider summaries are cached objects reused across requests. Deriving the
  // effective origin from the previous value would make an override permanent,
  // so the provider's verdict is preserved separately and recomputed.
  assert.match(server, /if \(thread\.baseOrigin === undefined\) \{ thread\.baseOrigin = thread\.origin \?\? "native"; \}/);
  assert.match(server, /thread\.origin = threadOrigins\.isUi\(providerName, thread\.id\) \? "ui" : thread\.baseOrigin;/);
});
