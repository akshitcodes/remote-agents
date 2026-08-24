# Handoff — remote-agents / codex-phone

Written 2026-08-10. Context for continuing this work in a fresh session.

## What the app is

A self-hosted Node bridge (`server.mjs`, ESM, no framework) plus a single-file PWA
(`public/index.html`, inline script, no build step) that exposes the owner's
already-running agent CLI sessions — Codex, Claude Code, Grok — to their phone.
It reads each CLI's session files from disk (`~/.codex/sessions`,
`~/.claude/projects`, `~/.grok/sessions`) and streams deltas over SSE.

- Live deployment: `~/Code/codex-phone`, port **8484**, LaunchAgents
  `com.codexphone.server` + `com.remoteagents.tunnel`.
- Reachable from the phone via Tailscale IP / tunnel; startup prints a QR.
- Deploy: client changes need a **PWA reload**; server changes need
  `launchctl kickstart -k gui/501/com.codexphone.server`.

## Control ownership update — 2026-08-24

The browser must use `GET /api/thread`'s `runtime.source` and `runtime.turnId` as
the ownership authority. Reopening a bridge-owned turn restores its real turn
ID, so Stop and Codex `turn/steer` continue to work; a stale turn ID is rejected
instead of steering a replacement turn.

A Codex Desktop-owned turn cannot be steered or interrupted from this separate
bridge app-server. Controlled two-process tests confirmed that boundary. Such a
follow-up uses Codex's native `thread/queue/*` API instead: stable client message
IDs prevent replay, queued messages survive browser/bridge restart, and the UI
can edit or cancel them before Codex consumes them. Queue ownership is never
inferred from a failed steer alone; `/api/thread/runtime` is rechecked after a
short settle at the turn-end boundary. If ownership cannot be confirmed, the UI
stores the message locally and explicitly leaves it unsent until sync recovers.

Grok keeps its provider-specific owned behavior: “Interrupt & send” waits for
confirmed ACP cancellation before dispatch. Claude keeps its owned live-steer
and interrupt paths. External turns for either provider are never process-killed
or force-taken. Planned deploys remain gated on zero bridge-owned live turns.

The deterministic suite is currently 124/124, and a real foreign-writer Codex
test passed native queue add/list/edit/delete with cleanup.

Thread ordering is also a live invariant in both list modes: provider/SSE run
events rerank the visible list immediately, running tasks form the leading
group, a newly-started task reveals that group at scroll position zero, and
every async list response is reranked again before paint so stale fetch order
cannot undo it. The server reads `public/index.html` on navigation instead of
caching it at process startup; after the first rollout containing this change,
future UI-only fixes need a page reload but no bridge restart.

Account-wide usage limits now use provider-native sources with private
last-known snapshots, so a transient refresh failure does not blank the Usage
sheet. Notification titles are thread-only and response previews retain the
beginning of the final answer instead of a rolling tail. The operating system's
PWA source label (for example, “from Agents”) is platform attribution and cannot
be removed from the Web Push payload.

## Current foundation — 2026-08-11 (supersedes older in-flight notes below)

**Deployed 2026-08-11 13:01 IST.** LaunchAgent PID changed to `18801`; port
8484, authenticated shell, manifest, SSE (`bridge: connected`), Codex/Claude/Grok
thread listing, model listing, approval recovery, lock-status API, service-worker
`remote-agents-v6`, and the still-running external Codex rollout were verified
after restart. The Cloudflare tunnel remained running.

The supported design is the self-hosted bridge and PWA. ChatGPT/Codex native
remote control is intentionally out of scope: this app must work across the
owner's multiple provider accounts without depending on ChatGPT remote-control
authentication.

- Every phone send has a client request ID and a durable server-side ledger.
  `dispatching` after a restart and provider acknowledgement timeouts become
  `uncertain`; the same request ID is never replayed automatically. Known
  pre-acceptance failures remain safely retryable.
- Codex uses one holder process per thread. Holders serialize sends, preserve
  native steering during a live turn, refuse forced takeover, and release an
  idle lease after 60 seconds. Reading a thread never acquires its writer lease.
- Claude uses a process for the active turn so phone steering works, waits for a
  real `message_start` before acknowledging delivery, times that acknowledgement
  out after 60 seconds without killing the possibly-live turn, and releases the
  process after a terminal result. This avoids the installed CLI's unreliable
  second stream-result envelope.
- Reconnect performs canonical thread and approval reconciliation. The UI keeps
  offline/cache state separate from authoritative sync, restores pending
  approvals, persists queued drafts locally, and distinguishes confirmed run
  markers from heuristic activity.
- The app shell is network-first and API responses are never service-worker
  cached. Cache version `remote-agents-v6` forces the reliability/image UI update onto
  installed PWAs.
- The deterministic suite currently contains 41 passing tests covering the send
  ledger, acknowledgement timing, Codex holder races/idle release, stable lock
  errors, approval recovery, run-confidence classification, attachments, provider
  image payloads, Grok cancel confirmation, and queue/retry lifecycle contracts.

The final Claude Opus/high review found and the implementation now covers three
additional edge cases: Claude acknowledgement timeout no longer makes a later
send wait forever, Codex `turn/start`/`turn/steer` RPC timeouts are classified as
delivery-uncertain, and writer-conflict queues require an explicit retry rather
than looping automatically. Retry-required queue state and the need for a new ID
after uncertainty survive reloads; approvals are only shown on their exact
thread; and a terminal Codex notification that beats the `turn/start` response
cannot resurrect a completed turn as active.

Current measured Codex behavior is substantially better than the historical
number below: resuming a completed 626 MB thread took **3.011 seconds** in the
current implementation, and releasing it took 24 ms. Treat the older ~30-second
measurement as historical, not an expected current baseline.

Hard limitation: a bridge-owned CLI turn is still a child process, so an
unplanned bridge crash can terminate that turn. Planned deploys must first prove
that the bridge owns no active turn. Moving holders into a separate supervised
runner would reduce crash coupling, but it also introduces orphan lifecycle,
authentication, upgrade, and emergency-release complexity; it is not a minor
pre-deploy change and is not required for the current safe-send foundation.

### Steering and image prompts — 2026-08-11

The mid-turn UI now reflects each provider's real control surface instead of
using one misleading behavior everywhere:

| Provider | Turn owned by this bridge | Turn running elsewhere |
| --- | --- | --- |
| Codex | Native `turn/steer`; text and images can be steered | Durable queue; no takeover or interrupt |
| Claude | A second stream-json user frame steers the live process; text and images work | Durable queue; resuming externally may stale the Mac UI, so it is not treated as reliable live steering |
| Grok | ACP has no live-injection method. “Interrupt & send” cancels, waits for confirmed terminal state, then sends | Durable queue/manual retry only; the bridge cannot safely cancel another process |

Image prompts are enabled for Codex and Claude from the composer picker or
clipboard paste. The installed Grok ACP advertises `image:false`, so Grok's
attachment button is disabled and the provider rejects image payloads explicitly
rather than dropping them. Images are decoded and capped at 2000 px, compressed
when needed, limited to 4 files / 3 MB each / 8 MB per prompt, magic-byte checked,
stored mode `0600` under `~/.codex-phone/attachments`, retained for 7 days, and
bounded by a 256 MB storage ceiling. APIs remain authenticated and are never
service-worker cached.

Queue and retry records include attachment references. Draft adoption migrates
pending/failed state from draft ID to native session ID. Stop durably deletes
queued messages. `delivery_uncertain` survives reload with explicit wording and
requires a deliberate retry with a fresh request ID; it is never auto-flushed.
Heuristic-only completion also never auto-sends: it exposes a manual retry after
telling the owner to inspect the latest transcript.

Three independent Claude Opus/high read-only passes reviewed the implementation.
Their duplicate-steer, retry-after-reload, reconnect, approval scoping, Stop,
draft-adoption, and uncertainty-label findings were fixed. The deterministic
suite now contains 41 passing tests, plus inline-script syntax, module syntax,
package-content, and whitespace checks.

Post-deploy live smoke tests uploaded and fetched a magic-valid PNG, confirmed
the v6 shell and SSE, listed threads/models for all three providers, and kept the
Cloudflare tunnel healthy. New isolated Codex and Claude image tasks both
accepted the real image and replied `OK`; transcript replay retained one image
marker. A Grok image send returned the intended `409 images_unsupported` without
starting a turn. The deployed browser showed the Codex attachment control and
history image, disabled Grok attachments, and explained `Interrupt & send` in
the Grok send-mode sheet. The app-server still logs periodic invalidated-token
errors while refreshing the ChatGPT model list, but the live Codex model list and
new image turn both succeeded; treat the log as noisy refresh/account state unless
a future real send fails.

---

## Verified facts about Codex internals

Established by measurement this session. Do not re-derive; do not contradict
without new evidence.

**The single-writer lock**
- Codex allows exactly ONE writer per thread. The lease is held **in memory** by
  whichever process has the thread loaded, and enforced at session init:
  `thread-store conflict: <id> already has an active writer`.
- There is **no steal / force / takeover** anywhere in the protocol (searched;
  only unrelated `forceRefetch`/`forceReload`/`forceRefresh`). A lease is released
  by its holder or when that process dies. **There is no lease column in the DB**,
  so there is never a stale lock to clean up.
- `thread/loaded/list` reports only the **calling process's own** loaded threads —
  it returns empty even when the desktop app has threads loaded. It is useless for
  detecting other holders. The only reliable signal is the conflict error text.
- Three clients compete on this machine: the Codex desktop app, the VS Code
  ChatGPT extension, and this bridge.
- Claude's equivalent refusal: `Session <id> is currently running as a background
  agent (bg)`. Claude otherwise **fails open** (no lock) where Codex fails closed.

**Protocol access**
- Spawn `/Applications/ChatGPT.app/Contents/Resources/codex app-server`, send
  `initialize` with `capabilities: { experimentalApi: true }`, then `initialized`.
  Without that capability, `remoteControl/*` is refused.
- **Discovery trick:** call any RPC with `{}` and the error names the missing
  field. That is how `thread/fork` → `threadId`, `thread/rollback` → `numTurns`,
  `remoteControl/client/list` → `environmentId` were found.
- `thread/rollback` needs the thread **loaded in the calling process** (unlike
  `thread/turns/list`, which reads the store) — otherwise `thread not found`.
- Working script templates in the session scratchpad: `do-fork.mjs`, `rb2.mjs`,
  `turns.mjs`, `rc-spike2.mjs` (scratchpad is NOT durable — copy anything needed).

**Sizes / performance**
- One thread's rollout is **651 MB** (`019fe072`). It is only ~50 K lines —
  individual records are enormous. Parsing it is fast (~1.5 s).
- **63% of its bytes are `compacted` records**: each compaction *appends* a full
  snapshot rather than replacing the previous one, so compaction inflates the log.
- `thread/fork` **copies the entire history** (the fork is 667 MB) and inherits any
  corruption. It does NOT reduce size or resume latency.
- Cold `thread/resume` on that thread ≈ **30 s**; `resumedThreads` in
  `providers/codex.mjs` then short-circuits it so later sends are 1–2 s.
- Codex stores **`model` and `reasoning_effort` per thread** in
  `~/.codex/sqlite/state_5.sqlite` (`threads` table). Authoritative — better than
  our localStorage copy. That DB also has `remote_control_enrollments`.

**Native remote control (spike, unfinished)**
- `remoteControl/status/read` works from a third-party client:
  `{"status":"disabled","serverName":"akshits-MacBook-Air-2.local",
    "installationId":"99f8e32d-d0c8-40f5-825e-f7fdddf66886","environmentId":null}`
- So the API is **reachable by third parties** — not first-party-only, as feared.
- Enrollment is scoped to an `environmentId`, minted presumably by
  `remoteControl/enable`. Related: `environment/add`, `environment/status`,
  `remoteControl/pairing/start`, `pairing/status`, `client/list`, `client/revoke`.
- **STOPPED HERE, awaiting explicit consent:** `remoteControl/enable` would
  register this Mac as a remote-control server under the owner's ChatGPT account
  and write to `remote_control_enrollments`. Not done.
- Why it matters: remote control is the only design that avoids the lease entirely
  — you attach to the process that already owns the thread instead of becoming a
  second writer. No resume, no 30 s, no lock, and the Mac's UI stays correct.
- **t3code does NOT solve this.** Its own architecture doc says it wraps
  `codex app-server` over JSON-RPC on stdio and "starts or resumes a session" —
  i.e. identical to us, so it inherits both the resume cost and the lock.

---

## Committed this session — `ce99802`

All in the live checkout. **Client parts are live after a PWA reload; server parts
went live with a restart already performed.**

1. **Authoritative run state** (`server.mjs`) — `activeTurns` set, maintained in
   `broadcast()` via `trackActiveTurn` on `turn/started` / `completed|failed|aborted`,
   plus draft→real id handover on `thread/adopted`. The thread list now does
   `t.running = activeTurns.has(...) || diskHeuristic`.
   *Bug it fixed:* run state was inferred from file timestamps. On a 651 MB rollout
   the `task_started` marker is far beyond the 96 KB tail window, so the check
   silently degraded to "written in the last 25 s" and the badge flapped — which is
   why the owner sent "continue" repeatedly into a live turn.
2. **`ASSUME_ACTIVE_MS` 25 s → 90 s** (`watch.mjs`) + corrected comment. The old
   comment claimed it only applied to providers without markers; in reality it is
   reached whenever the marker is beyond `TAIL_BYTES` (96 KB).
3. **Claude item-id parity** (`providers/claude.mjs`) — file history now emits
   `` `${message.id}:${blockIndex}` ``, matching the live stream. Previously file
   used bare `message.id` and live used `id:index`, so the same message rendered
   twice and the orphaned copy kept its `streaming` class forever (the blinking
   green carets).
4. **Render identity** (`public/index.html`) — `addAgent()` stamps
   `data-item-id` and removes any earlier bubble for the same item;
   `clearCarets()` clears `.msg.agent.streaming` from the **DOM** (the old code
   only iterated `state.items`, which `openThread`/refetch replace, orphaning
   bubbles permanently); plus a `setBusy(false)` invariant — nothing in flight,
   nothing blinking.
5. **Durable failed sends** — `state.failedSends` + `restoreFailedSends()` in
   `renderHistory`.
6. **Durable pending queue** — `cxp_pending` in localStorage, per
   `provider:threadId`; saved on enqueue/flush/steer-landing, restored in
   `renderHistory`. *This is the fix for messages vanishing:* a steer that cannot
   land deliberately stays pending, and the queue was memory-only, so every reload
   silently discarded it.
7. **Per-thread model/effort** — `cxp_thread_prefs`, applied in `openThread` and
   `initModels`, validated against the provider's real model list, global prefs as
   fallback, capped at 200 entries.

---

## In flight — agent building two features

Launched in the live checkout (`gpt-5.6-sol`, high). Report will be at
`scratchpad/lock-ui-report.md`. Already visible in the working tree:
`releaseThreadLock` in `server.mjs`, `claudeTurnError` + `THREAD_CONFLICT_CODE` in
`providers/claude.mjs`, and a new `owners.mjs` (`sessionHeldElsewhere`).

**Feature 1 — subtle write-lock status control.** A small chip in the existing
controls row (beside Model / Effort / permission-mode / Send-type), opening the
same bottom sheet style. Three states:
- "You have it" (bridge holds the lease, from `resumedThreads`) → **Release**
- "Open elsewhere" (conflict refusal seen) → explains where; **no** claim button,
  because taking a lease is impossible
- "Free" → **Warm up** (resume now), with copy that it is not a reservation

**Hard safety rule:** release must NEVER abort a running turn. If a turn is in
progress, refuse (`turn_in_progress`, 409) or defer until it ends, using
`activeTurns`. Also maps the conflict error to a stable code, the way
`steerErrorTag` / `steerFallbackReason` already do, so the UI can say "this thread
is open on your Mac; close it there to continue" instead of queuing silently.

**Feature 2 — send-path progress states.** Emit real stages over the existing SSE
`broadcast()` and render in the existing chip area: accepted → resuming (say so
when it is the slow cold path) → resumed → turn started → streaming. Today there
is nothing between pressing send and the first streamed item, which on a big
thread is 30+ seconds of silence that looks broken.

**Unverified, and it must say so:** whether `thread/close` mid-turn aborts or is
refused, and whether it releases one lease without disturbing the app-server's
other threads. Conservative default (defer until idle) is correct either way.

**Review before deploying:** the release guard genuinely consults `activeTurns`;
no `pkill`/`killall` anywhere; the inline client script still parses (a syntax
error bricks the phone app).

---

## The regression that explains the "it used to be seamless" feeling

**The bridge never releases a thread.** `providers/codex.mjs` calls neither
`thread/close` nor `thread/unsubscribe`, and `resumedThreads` is only ever added
to (cleared solely when the app-server dies). So the moment the phone touches a
thread, the Mac is locked out until the bridge restarts.

The thing holding the lease **is** the optimisation: `ensureResumed()` keeps
threads resumed for 1–2 s sends. We bought send latency and sold Mac↔phone
hand-off without noticing. Fix: `thread/close` on an idle timeout (~60 s) plus
pre-warm on thread open — fast sends while actively using the phone, lease freed
by the time you are back at the Mac.

---

## Open issues

**The corrupted thread.** `019fe072-078f-7880-9aaa-a41e0482f9db` contains a
`custom_tool_call` (`call_RbUmfopBmqIW6xL1nmk76cJp`) whose
`custom_tool_call_output` was never written — the owning process exited mid-tool-call
at ~17:07Z. `thread/resume` tolerates it (that is the 30 s), but request assembly
then fails: `codex_core::util: Custom tool call output is missing for call id`.
27 such errors logged.
- A fork was made (`019fecba-d62c-7e11-bb47-f11e13d4fb57`), inherited the
  corruption, was rolled back one turn (`thread/rollback numTurns:1` — 25 turns
  total), ran ~17:2x–17:51, then stopped.
- **The original is alive.** It was being written at 18:10Z by something that is
  not the bridge (bridge log stops at 17:49) — i.e. from the Mac, after a bridge
  restart released the lease. So the thread is NOT dead; it was unreachable
  specifically via our path.
- The fork is now the less valuable copy and occupies 667 MB. Deleting it is the
  owner's call (they asked that history not be deleted).

**Codex OAuth token gets invalidated** roughly daily — separate live problem.

**Disk.** Boot volume was 100% full (196 MiB free) at session start; freed to
~4.2 GiB via npm cache (3.2 GB), Homebrew (544 MB), pip (~190 MB), an idle
Playwright profile (185 MB). Then the fork consumed 667 MB. **`~/.cache/uv` is
30 GB and is the single biggest safe reclaim** (`uv cache clean`, official,
regenerable) — was stopped mid-run at the owner's request, so still present.
Other large: `~/.gemini` 17 GB (three near-identical `antigravity` copies),
`~/.codex/sessions` 17 GB, `~/Downloads` 13 GB, `~/.codex/logs_2.sqlite` 536 MB.
adbrew worktrees (9) are only ~322 MB total — not a problem. scan-world ~2.4 GB.

**Portability branch** — `feat/portable-install` in worktree
`~/Code/codex-phone-portable`, uncommitted, for shipping to external users.
Two ranked transports: Tailscale Serve (default) and Cloudflare named tunnel +
Access. No LAN mode; quick tunnels rejected (rotating origin, and Cloudflare
documents no SSE support — SSE is this app's live transport). Guards: QR printed
only after an authenticated HTTPS check succeeds, `--replace-origin` required to
change an installed PWA's origin, fails closed on malformed config, idempotent
(same port/token/URL on re-run). **Tested live and it correctly refused**: Tailscale
Serve config was created fine but TLS is broken on this machine — DNS and TCP fine,
then `tlsv1 alert internal error` from tailscaled, and `tailscale cert` hangs >140 s.
Suspects: the HTTPS toggle in the tailnet admin console, and a CLI/daemon version
split (Homebrew CLI 1.98.8 vs Tailscale.app daemon 1.98.9 — try the app's own
binary). `tailscale serve` was **reset to its original empty state** after testing.
`PORTABLE_PLAN.md` in that worktree has the full design.

---

## Recommended order of work

1. **`thread/close` on idle** — restores Mac↔phone hand-off (the regression above).
2. **Pre-warm resume on thread open** — moves the 30 s off the send path.
3. Finish the in-flight lock chip + progress states, review, deploy.
4. **Rename `auto`** — "Approve for me" maps to `approvalPolicy: on-request`,
   which *does* ask. The name means nearly the opposite of its behaviour. Zero
   prompts is "Full Access" (`never` + `danger-full-access`). This was reported as
   a bug and is really a naming problem.
5. **Per-thread model/effort from `state_5.sqlite`** instead of localStorage.
6. **Warn when a rollout crosses ~100 MB** — past that, resume latency and the
   unreadable-marker problem both bite. Fork/summarise before 650 MB, not after.
7. **Remote control spike** — only with explicit consent for `remoteControl/enable`.

## The tests that would have caught all of this

None exist. Each is a fixture plus an assertion:
- a rollout fixture larger than `TAIL_BYTES` → run state must not flip while quiet
- parity: same message from file vs live stream → **same item id**
- enqueue → simulate reload → message still present
- release guard: `activeTurns` populated → release refuses

## The pattern behind every bug this session

Two sources of truth for one fact, with no rule about which wins:

| Fact | Authority | What was also used |
|---|---|---|
| Is a turn running? | `turn/started` | file mtime + a 25 s guess |
| Is this the same message? | item id | position in the DOM |
| Did my message exist? | pending queue | a DOM bubble |
| Who owns this thread? | the lease | nothing; discovered via error strings |

Rules that follow: name one authority per fact and make inference visibly
second-class; never acknowledge user intent in the UI before persisting it;
degrade **loudly** (a 10-minute tolerance silently collapsing to 25 s was the
worst part); when caching something externally visible, the release path is part
of the feature; model the constraint instead of tripping over it.

## Corrections to earlier claims — do not repeat these

- `thread/fork` does **not** reduce size or resume latency; it copies everything.
- Thread `019fe072` did **not** need a rollback to be usable — the Mac continues
  it fine. It was unreachable via the bridge at that moment, which is different.
- `thread/loaded/list` cannot detect other processes' locks (assumed it could).
- Native remote control is **not** first-party-only at the API level.
- The bridge, not the desktop app, was holding leases — because it never releases.
