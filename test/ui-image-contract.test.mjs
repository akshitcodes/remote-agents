import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

test("image references survive queue, steer, send, retry, and reload paths", () => {
  assert.match(html, /attachments: e\.attachments \?\? \[\]/);
  assert.match(html, /attachmentIds: \(entry\.attachments \?\? \[\]\)\.map/);
  assert.match(html, /attachmentIds: attachments\.map/);
  assert.match(html, /doSend\(entry\.text, \{ attachments: entry\.attachments/);
  assert.match(html, /state\.failedSends\.push\(\{ provider, threadId, text, requestId, attachments, retryWithNewId \}\)/);
  assert.match(html, /Steer delivery could not be confirmed/);
  assert.match(html, /retryWithNewId/);
});

test("Grok image UI is disabled and cancel-before-send requires owned active work", () => {
  assert.match(html, /activeProvider\(\) === "grok"/);
  assert.match(html, /requireActive: true/);
  assert.match(html, /Stopping Grok safely, then sending this message/);
});

test("stop, draft adoption, and reconnect preserve queue truth", () => {
  assert.match(html, /const stopped = await interruptApi\(\);[\s\S]*?if \(!stopped\) \{ return; \}[\s\S]*?state\.pending = \[\];\s*savePending\(\)/);
  assert.match(html, /migrateThreadLocalState\(activeProvider\(\), state\.active\.id, params\.sessionId\)/);
  assert.match(html, /await api\("\/api\/message"[\s\S]*?finishSendProgress\(\);\s*dropFailedSend\(id\)/);
  assert.match(html, /Completion could not be confirmed — check the thread, then tap Retry to try now/);
  assert.match(html, /Delivery uncertain — check the latest messages, then tap Retry only if needed/);
  assert.match(html, /if \(p\.bubble\) \{ p\.bubble\.remove\(\); \}/);
  assert.match(html, /function openPendingEditSheet\(entry\)/);
  assert.match(html, /function removePendingEntry\(entry\)/);
  assert.match(html, /entry\.dispatching = true;\s*entry\.mayHaveDispatched = true;\s*syncPendingActions\(entry\);\s*savePending\(\)/);
  assert.match(html, /edit\.textContent = "Edit"/);
  assert.match(html, /cancel\.textContent = "Cancel"/);
  assert.match(html, /mayHaveDispatched: !!e\.mayHaveDispatched/);
  assert.match(html, /entry\.dispatching \|\| entry\.mayHaveDispatched/);
  assert.match(html, /state\.pending\.includes\(entry\) \|\| entry\.dispatching \|\| entry\.mayHaveDispatched/);
  assert.match(html, /e\.code === "delivery_uncertain" \|\| !!e\.reach \|\| !e\.status \|\| e\.status >= 500/);
});

test("task rows expose grouped subagents and device-scoped notification modes", () => {
  assert.match(html, /childCount} subagent/);
  assert.match(html, /document\.createElement\("button"\)/);
  assert.match(html, /name: child\.agentNickname \|\| child\.name \|\| "Subagent"/);
  assert.match(html, /parentThreadId: t\.id/);
  assert.match(html, /data-notify-mode="once"/);
  assert.match(html, /data-notify-mode="follow"/);
  assert.match(html, /Subagent work stays grouped/);
  assert.match(html, /\/api\/thread\/notifications/);
  const rowTemplate = html.slice(html.indexOf('div.innerHTML = `<div class="row-head"'), html.indexOf('div.querySelector(".preview")'));
  assert.ok(rowTemplate.indexOf("subagent-action") < rowTemplate.indexOf("notify-action"), "subagent disclosure stays left of the right-anchored notification action");
});

test("task list has compact provider-agnostic and provider-specific views", () => {
  assert.match(html, /data-view="recent"/);
  assert.match(html, /data-view="provider"/);
  assert.match(html, /\/api\/threads\/recent/);
  assert.match(html, /listView === "recent"/);
  assert.match(html, /More sessions/);
  assert.match(html, /Load more sessions/);
  assert.doesNotMatch(html, /class="chip branch"/);
  assert.doesNotMatch(html, /querySelector\("\.branch"\)/);
  assert.match(html, /PROVIDER_ICONS/);
  assert.match(html, /providerMark\.setAttribute\("aria-label", providerName\)/);
  assert.match(html, /new-session-projects/);
  assert.match(html, /new-session-footer/);
  assert.match(html, /new-session-host/);
  assert.match(html, /Number\(b\.count \?\? 0\) - Number\(a\.count \?\? 0\)/);
  assert.match(html, /if \(providerChanged\)[\s\S]*?await initModels\(threadProvider\);[\s\S]*?await loadThreadSettings\(t\)/);
  assert.match(html, /localStorage\.removeItem\("cxp_thread_prefs"\)/);
  assert.match(html, /\/api\/thread\/settings/);
  assert.match(html, /function updateListChrome\(\)[\s\S]*?button\.setAttribute\("aria-pressed", String\(selected\)\)[\s\S]*?if \(state\.active\) \{ return; \}/);
  assert.match(html, /button\.setAttribute\("aria-pressed", String\(selected\)\)/);
  assert.match(server, /nextState\[providerName\] = \{ unavailable: true \}/);
  assert.match(server, /recentProviderUnavailable\(cursorState\[name\]\)/);
  assert.match(html, /function syncProviderSeg\(\)[\s\S]*?button\.setAttribute\("aria-pressed", String\(selected\)\)/);
  assert.match(server, /extname\(iconName\).*"image\/svg\+xml"/);
});

test("live run-state transitions re-rank Recent Work and reconcile canonical state", () => {
  assert.match(html, /function rankLiveThreads\(threads, runningKeys\)/);
  assert.match(html, /const runningNow = isThreadRunning\(t\)/);
  assert.match(html, /if \(had !== on && live\)[\s\S]*?touchLiveThread\(provider, tid\)[\s\S]*?rerankRecentRows\(\)[\s\S]*?scheduleListReconcile\(\)/);
  assert.match(html, /function rerankRecentRows\(\)[\s\S]*?state\.threads = rankLiveThreads\(state\.threads, state\.running\)[\s\S]*?scrollTop/);
  assert.match(html, /const LIST_RECONCILE_MS = 600/);
  assert.match(html, /if \(state\.listView === "recent"\) \{ loadThreads\(false\)\.catch/);
  assert.match(html, /markRunning\(threadProvider, t\.id, !!t\.running, \{ confidence: t\.runConfidence, live: false \}\)/);

  const notifyStart = html.indexOf("function onNotify(method, params, provider)");
  const notifyEnd = html.indexOf("// Once real turn output arrives", notifyStart);
  const notify = html.slice(notifyStart, notifyEnd);
  assert.ok(notify.indexOf('method === "turn/started"') < notify.indexOf("provider !== activeProvider()"), "cross-provider run state is recorded before transcript filtering");
});

test("desktop workspace keeps session navigation visible and constrains the chat", () => {
  assert.match(html, /@media \(min-width: 960px\)/);
  assert.match(html, /body\.thread-open #app[\s\S]*?grid-template-columns: clamp\(310px, 24vw, 380px\) minmax\(0, 1fr\)/);
  assert.match(html, /body\.thread-open #listView[\s\S]*?display: block !important/);
  assert.match(html, /body\.thread-open #transcript,[\s\S]*?width: min\(calc\(100% - 32px\), 70vw, 1100px\)/);
  assert.match(html, /body\.thread-open\.sidebar-collapsed #app \{ grid-template-columns: 0 minmax\(0, 1fr\); \}/);
  assert.match(html, /body\.thread-open\.sidebar-collapsed #listView[\s\S]*?visibility: hidden/);
  assert.match(html, /id="sidebarToggleBtn"[\s\S]*?aria-expanded="true"/);
  assert.match(html, /function toggleSidebar\(forceExpanded = false\)/);
  assert.match(html, /sidebarCollapsed: state\.sidebarCollapsed/);
  assert.match(html, /border-left: 0;[\s\S]*?border-right: 0;/);
  assert.match(html, /body\.thread-open #backBtn \{ display: none !important; \}/);
  assert.match(html, /body\.thread-open #viewSeg,[\s\S]*?body\.thread-open #newBtn \{ display: flex !important; \}/);
  assert.match(html, /<aside id="listView" aria-label="Agent sessions">/);
  assert.match(html, /<main id="chatView" aria-label="Selected agent conversation">/);
  assert.match(html, /className = "row" \+ \(selected \? " active-thread" : ""\)/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /document\.body\.classList\.add\("thread-open"\)/);
  assert.match(html, /document\.body\.classList\.remove\("thread-open"\)/);
  assert.match(html, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(html, /event\.key === "Escape"/);
});

test("composer settings fail closed and distinguish confirmed values from next-turn overrides", () => {
  assert.match(html, /id="settingsTruth" data-state="loading" role="status"/);
  assert.match(html, /function dispatchReadiness\(\)[\s\S]*?No exact model is selected/);
  assert.match(html, /settingsTruth\.state === "error"/);
  assert.match(html, /Next model/);
  assert.match(html, /Exact settings sent to provider/);
  assert.match(html, /const accepted = await api\("\/api\/message"/);
  assert.match(html, /const dispatch = \{[\s\S]*?model: state\.model,[\s\S]*?approvalPolicy: m\.approvalPolicy/);
  assert.match(html, /Current turn accepted · next override saved/);
  assert.match(html, /state\.sendMode === "steer" && !state\.externalTurn/);
  assert.match(html, /Queue \(external\)/);
  assert.match(html, /state\.uploadingAttachments > 0 \|\| !readiness\.ready/);
  assert.match(html, /Nothing was queued or sent/);
  assert.match(html, /providerExact/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /aria-labelledby="sheetTitle" inert/);
  assert.match(html, /setAttribute\("inert", ""\)/);
  assert.match(html, /Keep provider-managed policy/);
  assert.match(html, /class="opt opt-button/);
  assert.match(html, /threadProvider !== state\.modelsProvider/);
  assert.match(html, /if \(!state\.active\) \{ await initModels\(name\); \}/);
  assert.match(html, /const usageProvider = activeProvider\(\)/);
  assert.match(server, /validateDispatchSettings\(provider\.name, body, listed, recorded\)/);
  assert.match(server, /validateNewThreadModel\(p\.name, body\.model, listed\)/);
});
