# Review: remote-agents bridge read/write architecture

## Findings, ordered by severity

### 1. P1 — the first file delta after opening a thread is silently discarded

**Confidence:** High  
**Files:** `server.mjs:130-179`, `watch.mjs:314-329`, `public/index.html:2224-2245`

`sentItems` is not initialized by `GET /api/thread`. On the first changed-file read, this line makes the *new* length the baseline:

```js
const already = sentItems.get(key) ?? items.length;
```

If the phone fetched N items, then the foreign agent appended five, the watcher reads N+5 and sets `already` to N+5. No items are sent, and the cursor is advanced to N+5. This is the normal first-growth path, not an exotic race.

The watcher deliberately sends a first observation with `changed: false` (`watch.mjs:326-329`), so it does not establish a content baseline either. Seed the server-side snapshot/cursor when interest begins or when `/api/thread` returns. More robustly, make the response carry a per-file generation and absolute end offset, and have the client subscribe/acknowledge from that exact snapshot.

There is a second fetch/SSE race: a delta may be rendered while the initial or resync fetch is in flight, then `renderHistory` replaces the DOM with an older response (`public/index.html:1197-1203`, `2132-2137`). Buffer deltas during a fetch and apply only those newer than the returned snapshot, or perform snapshot-plus-subscribe through one ordered protocol.

### 2. P1 — item-count deltas cannot represent the mutations the parsers already perform

**Confidence:** High  
**Files:** `codex-rollout.mjs:241-255`, `providers/claude.mjs:513-520`, `providers/grok.mjs:709-715`, `server.mjs:161-171`

The premise at `server.mjs:113-116`—that every change is a newly appended UI item—is false even though the underlying JSONL record is append-only. All three parsers mutate an earlier `commandExecution` item when a later tool-result record arrives. Its status, output, and exit code change, but `items.length` does not. `emitExternal` consequently sends nothing.

This means an externally driven command can remain “running” forever on the phone and never receive its output through the delta path. The same class of bug applies to any future record that enriches an earlier item.

Do not use materialized item count as the change protocol. Either:

- emit immutable log-derived operations such as `append`, `replace(index,item)`, and `reset`; or
- compare a stable digest/version for the visible tail and send replacements for changed positions; or
- keep deltas only as an optimization but send `changed: true` whenever the materialized snapshot changed without an append, forcing a bounded tail resync.

The first option is the cleanest. A source byte offset is a useful cursor, but it is not itself a UI-item cursor because one source record can update an existing item or produce zero/multiple items.

### 3. P1 — Grok permission settings are not enforced

**Confidence:** High  
**Files:** `providers/grok.mjs:50-73`, `providers/grok.mjs:868-878`, `providers/grok.mjs:1045-1050`, `providers/grok.mjs:1280-1300`

`permissionArgsFor()` is never called. `ensureSession()` builds arguments for model and effort, then appends only `stdio`; the selected `mode` is assigned after the process is already created. Separately, every ACP `requestPermission` selects an allow-looking option (or simply the first option).

So “plan”, “manual”, and “accept edits” do not provide the restrictions the UI claims, and headless permission prompts are effectively auto-approved. This is not merely a missing feature; it is a misleading safety control. Wire the mode into the pool key and spawn arguments, and implement actual denial/phone approval for manual mode. Until then, hide or clearly label unsupported modes rather than presenting them as enforced.

### 4. P1 — rewrites, truncation/regrowth, and compaction have no recovery protocol

**Confidence:** High  
**Files:** `codex-rollout.mjs:300-349`, `server.mjs:167-171`, `public/index.html:959-981`

The Codex cache resets only when its prior offset is greater than the current size. It misses same-size rewrites, larger rewrites, inode replacement with a file at least as large, and truncate-then-regrow between reads. In those cases it combines a stale parsed prefix with bytes from the new file.

Even when a shrink is noticed by the parser, the server only lowers `sentItems`; it does not tell clients to discard their old generation. `appendExternalItems` can deduplicate overlap and detect a forward gap, but it cannot recover when absolute indices have been reused by a new file generation.

Track at least file identity (`dev`/`ino` where meaningful), size, mtime/ctime, and a small prefix fingerprint. Every delta should include a generation/revision. On replacement, compaction, parse-schema change, or impossible cursor movement, send `reset` and fetch a fresh tail. A rewrite of an earlier record also needs a replacement/reset, even if total item count is unchanged.

Parallel writers are unsafe for the same reason and can additionally interleave partial JSONL writes. Treat one writer per thread as an invariant; detect or refuse a second writer rather than assuming append order is sufficient.

### 5. P1 — message submission has no idempotency or single-writer guard

**Confidence:** High  
**Files:** `server.mjs:669-678`, `providers/codex.mjs:366-398`, `providers/claude.mjs:882-945`, `providers/grok.mjs:1280-1331`

A phone timeout or reconnect is ambiguous: the CLI may have accepted the turn even though the HTTP response was lost. Retrying can submit the same user message twice. Also, a file marker saying “running” does not stop the bridge from resuming/loading the same thread and starting another controller against it.

Add a client-generated idempotency key to `/api/message`, persist a small request ledger, and return the same accepted result on retry. Before sending, acquire a bridge-local per-thread lease and check the file-derived running state. If another process owns an active turn, queue/refuse unless the provider exposes a supported steering/attach operation. This matters more than shaving milliseconds off a warm send.

### 6. P2 — `changed` fallback is dead, so read failures and non-append changes do not refresh the client

**Confidence:** High  
**Files:** `server.mjs:130-179`, `public/index.html:2239-2245`

The client schedules a full refresh only when the external event contains `changed: true`. But `emitExternal` initializes `payload` without `changed` and never adds it. The catch comment says the bare ping tells the app to refresh, but the client does not do that. A provider read failure, or a successful read whose item count did not grow, is therefore silent.

Include an explicit result (`delta`, `unchanged`, `resync`, `reset`, `error`) instead of relying on missing fields. Do not turn every parse failure into an immediate full reread loop; back off and surface stale state after repeated failures.

### 7. P2 — reads still have CLI side effects for Claude and Grok

**Confidence:** High  
**Files:** `providers/claude.mjs:549-562`, `providers/grok.mjs:722-738`, `providers/grok.mjs:975-983`

The brief says reading is decoupled from the CLIs, but opening a Claude or Grok thread prewarms a new CLI process and resumes/loads that session. Grok suppresses replay while `loadingHistory`; Claude has no equivalent replay guard. Even if Claude currently emits no history before a prompt, a read now depends on undocumented process behavior and creates a ten-minute process allocation per opened thread.

I agree with removing Codex resume from `readThread`, but the invariant should apply to every provider: GET/list/read must be pure file operations. Start or resume a writer only after an explicit send. If cold latency is unacceptable, make prewarm an explicit write-control operation and guarantee that it cannot emit transcript events.

### 8. P2 — “live notifications only for a turn started on this device” is not representable today

**Confidence:** High  
**Files:** `server.mjs:38-47`, `server.mjs:344-348`, `public/index.html:996-1027`, `public/index.html:2219-2245`

All provider notifications are broadcast to every SSE client, and `/api/message` has no client ID. A second phone viewing the same thread will render the first phone's CLI stream as if it were local. There is no origin token with which to enforce the proposed invariant.

Pass `clientId` and a client-generated turn/request ID on send, bind provider events to that turn, and tag SSE frames with the origin. Only the originating client should render ephemeral provider deltas. Other clients should consume the canonical file-derived stream. At turn completion, the origin should reconcile against the file snapshot as well; otherwise a final file delta arriving just after `setBusy(false)` can duplicate its optimistic/live-rendered user and assistant content.

### 9. P2 — running-state detection is useful but not “precise”

**Confidence:** High  
**Files:** `watch.mjs:32-34`, `watch.mjs:191-225`, `watch.mjs:229-260`

Codex and Claude markers are explicit, but the implementation only examines the last 96 KiB. A long tool output can push the start/user marker out of that tail. The result becomes `null`, which falls back to a 25-second mtime heuristic. Conversely, the ten-minute stale cutoff can call a genuinely long, quiet tool invocation dead. Therefore the brief overstates this as precise.

Maintain running state incrementally from a durable source offset, rather than repeatedly searching a fixed byte tail. On startup, scan backward in growing chunks until a decisive marker is found or a defined cap is reached. Keep “unknown” distinct from false in the API/UI. For Grok, using `updates.jsonl` sounds better, but verify its lifecycle: whether it is append-only, whether load/replay events appear, and which event definitively commits turn completion.

### 10. P2 — the existing Codex timeout does not provide useful fail-fast recovery

**Confidence:** High  
**Files:** `providers/codex.mjs:147-217`

Every RPC already has a timeout, so plan item 2 is partly already implemented. It is 180 seconds, which is effectively a hang for a phone UI. More importantly, timing out only removes one pending request; it leaves the unhealthy child alive, so subsequent RPCs repeat the three-minute failure. Completed requests also leave their timer objects scheduled until 180 seconds, although their callbacks become no-ops.

Use a short initialization deadline and reasonable per-method deadlines, clear timers on completion, and treat an init timeout/closed transport as a process-health failure: reject all pending work, terminate the owned child, then restart with bounded exponential backoff and a circuit breaker. Add explicit shutdown handling (`SIGINT`, `SIGTERM`, server close) with TERM-then-KILL escalation for children owned by this bridge. Do not broadly kill arbitrary `codex app-server` processes; record PID plus process start identity for children you own.

## Review of the diagnosis

Version skew is a strong hypothesis, but the brief states it too conclusively. The `missing field base_instructions` error is good evidence that 0.145.0 is reading state written in a newer schema. It does not by itself prove that the OAuth/transport fatal error has the same cause, or that using the bundled binary fixes app-server startup under the bridge's environment.

I would call the diagnosis confirmed only after an A/B test: launch each exact binary with the same environment and home/config, perform `initialize`, and record exit/status and stderr. Then run the bundled binary with MCP initialization controlled or disabled if supported. The fact that Desktop works is evidence, but Desktop may supply different environment, arguments, credentials, lifecycle handling, or embedded services.

The current resolution logic (`providers/codex.mjs:17-57`, `147-148`) also equates “ChatGPT.app exists” with “its bundled CLI is the compatible writer.” That is not always true on a machine with Desktop, CLI, and IDE sessions of different versions. The config override should remain first, but automatic selection should enumerate candidates, run `--version`, compare against recent rollout `cli_version` values, probe app-server initialization, and expose the selected path/version in a health endpoint. Treat the app bundle path as an implementation detail that can move between releases.

## Answers to the architecture questions

### Polling versus `fs.watch` / FSEvents / tailing

Keep polling `stat` as the correctness backstop. `fs.watch`/FSEvents can coalesce events, report directory-level changes, and lose events; it is a good latency hint, not a source of truth. A hybrid is best: watch the containing directory to wake quickly, debounce, then stat and reconcile; retain a slower periodic poll to recover missed notifications.

Tailing by byte offset is materially better than rebuilding a full materialized thread and diffing item counts. The tail parser should produce explicit operations and advance its source cursor only through complete newline-terminated records. Persist generation plus offset per watched thread. This also makes running-state tracking and Grok `updates.jsonl` parsing incremental. Do not conflate “tail by bytes” with “append UI items”; later records can update earlier UI state.

### Is absolute item index plus appended items robust enough?

Only under much stronger assumptions than the code satisfies: immutable materialized items, one writer, no rewrite/rotation/compaction, deterministic parsing, and an ordered snapshot/delta handshake. Today it breaks on:

- the first growth after a new baseline;
- tool results that mutate prior items;
- truncate/regrow, replacement, compaction, or same-size rewrite;
- concurrent writers or interleaved partial records;
- parser-version changes that alter how many items earlier records produce;
- initial-fetch/resync responses racing with SSE deltas;
- multiple clients at different snapshot positions.

Use `{generation, sourceOffset, revision}` as the stream cursor and operations such as append/replace/reset. A client that sees a generation mismatch or non-contiguous revision must refetch. Absolute item index can remain inside one generation as an addressing mechanism, not as the entire consistency model.

### Can the write path be made as robust as the read path?

Not fully. The session log is an observation interface, not a command interface. Without owning the original process or using a vendor-supported attach/control channel, writing necessarily means starting another supported CLI/app-server controller. Do not write directly to session files.

The defensible design is to make the control plane supervised and the file transcript canonical: exact/capability-tested binaries, health checks, short timeouts, bounded restart, per-thread single-writer leases, idempotent sends, and reconciliation from disk after every turn. Provider live notifications should be ephemeral acceleration, never a second durable history authority. If an externally owned turn is active, queue the reply or require an explicit takeover rather than allowing parallel writers.

### Will the 150-item window and backward paging bite?

The basic page shape is reasonable for append-only history. `loadEarlier` preserves `renderedItems`, which is correct because prepending older items must not move the absolute tail cursor. However, it overwrites `state.itemWindow` with the older page's window (`public/index.html:942`), so that object no longer describes the full range currently rendered; split it into `earliestLoaded` and `latestSnapshotEnd` to avoid future mistakes.

The larger issue is consistency across generations and concurrent appends. `before=<absolute index>` works while old indices never move. A compaction/reparse can return overlap, gaps, or the wrong page. Include generation/revision in page requests, reject stale pagination with a reset response, and deduplicate/reconcile operations. Also preserve a stable scroll anchor element rather than only a pixel distance when inserting large, asynchronously rendered Markdown blocks.

### Version skew across three third-party CLIs

Treat each provider as a versioned adapter, not one parser plus hopeful fallbacks:

1. Discover and report the exact executable path/version and observed log schema/version.
2. Maintain a small compatibility matrix and capability probes; fail visibly when outside it.
3. Keep captured, sanitized fixtures from supported CLI versions and run list/read/incremental/rewrite/running-state contract tests against them.
4. Preserve unknown records and telemetry counters so format drift is visible instead of silently dropping content.
5. Make parsers resettable by schema version and file generation.
6. Prefer provider-supported machine protocols for writes, but keep the disk transcript as the post-turn canonical result.

For Codex specifically, selecting the Desktop binary first is a useful emergency recovery attempt, not a general compatibility strategy. Probe it before declaring the bridge ready and show the chosen path, binary version, recent rollout version, and any mismatch in the UI.

## Recommended plan and order

1. **Immediately correct or disable Grok's misleading permission modes.** This is the most serious safety issue found.
2. **Fix the delta consistency model.** Seed a real snapshot, add generation/revision plus replace/reset semantics, handle fetch/SSE races, and make the file-derived view canonical.
3. **Harden sends.** Add idempotency, per-thread writer leases, external-running checks, origin IDs, and post-turn file reconciliation.
4. **Restore Codex writing with observable binary selection and process supervision.** Keep the explicit override; probe candidate versions; shorten timeouts; kill/restart only owned children; expose health.
5. **Remove Claude/Grok prewarm from read methods.** Resume only on explicit send, and tag live events with their originating request/client.
6. **Make running state incremental, including verified Grok `updates.jsonl` boundaries.** Represent unknown honestly.
7. **Then make Claude and Grok transcript parsing incremental.** Reuse the source-cursor/generation framework, not Codex's current item-count assumptions.
8. **Add filesystem notification hints only after correctness tests pass.** Retain polling as reconciliation.

I would not put “make everything incremental” ahead of protocol correctness. An incremental parser makes stale or missed state cheaper, but it does not make it correct.

## Testing gaps

There is no project test script in `package.json`, and I found no repository tests covering these flows. Before relying on the redesign, add deterministic tests for:

- open at N, append before the first watched read, and verify N+1 arrives;
- tool call append followed by tool-result mutation with no item-count increase;
- partial final JSONL line completed by a later write;
- truncate, same-size rewrite, inode replacement, and truncate-then-regrow past the old offset;
- initial fetch/resync racing an SSE delta;
- two browser clients on one thread, only one originating the turn;
- HTTP response loss after the CLI accepts a send, followed by retry with the same key;
- external turn active while the phone attempts a send;
- 150-item paging while new tail records arrive and after a generation reset;
- each supported CLI fixture/version, with unknown-record and schema-drift assertions;
- Grok permission behavior for every UI mode;
- child cleanup on normal shutdown, crash, init timeout, and restart.

## Bottom line

The file-first read direction is right, and polling a foreign process's log is a defensible foundation. The current implementation is not yet a reliable append stream: its first-delta baseline is wrong, its parsers mutate earlier items, and it has no file-generation or request-idempotency model. I also disagree that Codex/Claude running state is precise and that the version-skew diagnosis is fully proven. Fix those consistency and safety contracts before optimizing all providers for incremental parsing.
