# Review request: remote-agents bridge — read/write architecture

You are reviewing a real, deployed system. Please be critical and specific.
Disagree where you think I am wrong. I want your review of (a) the current
architecture, (b) the diagnosis below, (c) my plan — and your own suggestions,
including anything I have missed or got backwards.

## What the project is

`remote-agents` (local clone `~/Code/codex-phone`) is a self-hosted Node bridge
that exposes the user's **existing local coding-agent CLI sessions** — Codex,
Claude Code, Grok — to a mobile PWA. It runs on the user's Mac, behind a
Cloudflare tunnel, and the phone is a client. No third-party service.

The user's actual workflow, which constrains everything:

- They start Codex sessions in **Codex Desktop (ChatGPT.app)**.
- They start Claude sessions in the **Claude Code VS Code extension**.
- They start Grok sessions in the **Grok CLI**.
- Then they walk away from the Mac and want to **watch those sessions live from
  their phone, and reply to them**, seamlessly.

Critically: those sessions are started by processes the bridge does **not** own
and cannot wrap. So "just spawn the agent yourself and stream its stdout" — the
approach a competitor (t3code) uses — is not available for the main use case.
The only shared surface between the agent process and the bridge is the CLI's
own **session log file on disk**.

## Current architecture

Single Node process. `server.mjs` + `providers/{codex,claude,grok}.mjs` behind a
common interface (`listThreads`, `readThread`, `send`, events). SSE to the
browser. A PWA with an IndexedDB cache and a service worker.

### Read path (list a session, open it, follow it live)

All three providers now read the CLI's own session files directly:

- **Codex** — `~/.codex/sessions/**/rollout-*.jsonl`. I recently moved this OFF
  `codex app-server` (see diagnosis). Parsed incrementally: the parse state is
  cached per file and fed only bytes appended since last read, in 16MB slices
  (these files reach 1.0GB; a single `Buffer.toString()` over that throws
  ERR_STRING_TOO_LONG). Records are mapped to UI items myself.
- **Claude** — `~/.claude/projects/*/<id>.jsonl`. Re-parses the WHOLE file on
  every read. No incremental cache.
- **Grok** — `~/.grok/sessions/<urlencoded-cwd>/<id>/chat_history.jsonl`. Also
  re-parses the whole file every read.

Following a live turn: a watcher (`watch.mjs`) polls (1s `stat`) the session
files of threads clients report having on screen (presence), and on growth the
server re-reads the thread, diffs against how many items it has already sent,
and pushes ONLY the appended items over SSE. The client appends them with the
same renderer used for full history. Position (index) is the identity, not item
id — Claude's items have missing and duplicate ids. Delta reads are throttled to
one in flight per thread, min 4s, with a trailing read.

Thread open returns only the LAST 150 items plus `{start,end,total,hasMore}`;
the client pages backwards on demand.

"Is a turn running?" is read off the same files:
- Codex: explicit `task_started` / `task_complete` event records. Precise.
- Claude: assistant record with `stop_reason: end_turn`. Precise.
- Grok: NO marker used — falls back to "file modified within 25s". A guess.
- All: a turn whose marker says running but which has been silent >10min is
  treated as dead, because an interrupted turn never writes its end marker.

### Write path (send a message from the phone)

- **Grok** — persistent ACP session (`grok agent stdio`), warm pool keyed by
  thread. Warm turn reaches the model in 3–5ms (cold spawn was 12.8s).
- **Claude** — persistent `claude -p --input-format stream-json
  --output-format stream-json`, one process per thread, reused across turns.
- **Codex** — `codex app-server` JSON-RPC. Currently BROKEN (below).

### Measured today (real user sessions)

| provider | list | open | reopen | items |
|---|---|---|---|---|
| codex  | 156ms | 23ms / 317KB | 16ms  | 11,491 |
| claude |  76ms | 213ms / 139KB | 150ms | 2,091 |
| grok   | 408ms | 86ms / 255KB | 15ms  | 228 |

Codex reopens an 11k-item thread in 16ms (incremental). Claude does full work
every time and is only fast because its threads are still small.

## Diagnosis of the Codex write-path failure

`codex app-server` spawned by the bridge hangs: every RPC (list, read, send)
never returns. Bridge log shows, at startup:

```
codex_models_manager::cache: failed to load models cache: missing field `base_instructions`
rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthR...
codex_rmcp_client::oauth::refresh_transaction: error=failed to refresh...
```

I first blamed a stuck MCP OAuth refresh (the user has 11 MCP servers in
`~/.codex/config.toml`). The user asked the obvious question I had missed: why
does Codex Desktop work with the same MCP servers? Answer — **two different
binaries sharing one state directory**:

- ChatGPT.app bundles `codex-cli 0.147.0-alpha.6.5`
- the bridge runs `/opt/homebrew/bin/codex` = `codex-cli 0.145.0`
- session files record `cli_version: 0.147.0-alpha.6.5`

So the newer binary writes `~/.codex` state (model cache, and possibly auth/MCP
token formats) that the older binary cannot parse, and the older one dies during
init. Version skew, not a broken MCP server.

## My plan (please review and improve)

1. **Codex binary resolution.** Stop hard-coding `codex` from PATH. Prefer the
   same binary that is actually writing the sessions: ChatGPT.app's bundled
   `codex`, else PATH, configurable via `~/.codex-phone/config.json`. Rationale:
   we share `~/.codex` state with whichever Codex the user actually uses, so we
   should speak the same version.
2. **Fail fast, visibly.** Any app-server RPC gets a timeout and surfaces a real
   error to the UI ("Codex app-server isn't responding") instead of hanging.
   Also: I see orphaned `codex app-server` children surviving bridge restarts.
3. **Make everything incremental.** Give Claude and Grok the same cached
   incremental parse Codex now has. Today they re-read and re-parse whole files
   on every poll and every open.
4. **Grok running-state.** Its session dir contains `updates.jsonl` — a logged
   ACP update stream with real `method` events. Use those turn boundaries
   instead of the mtime guess.
5. **Kill a duplicate-render class.** A message rendered twice in the UI traced
   to app-server history replay: opening a thread called `ensureResumed()`, and
   a resume replays history as live notifications on top of the transcript just
   drawn. I removed the resume from the read path. I want a stronger invariant:
   live notifications only render for a turn started on THIS device; everything
   else comes from the file watcher.

## Questions I want your opinion on

- Is polling `stat` at 1s + re-read + diff the right mechanism for following a
  foreign process's session log, or is there a materially better one (fs.watch /
  FSEvents, inotify-style, tailing by offset and parsing only new records into
  events rather than diffing item counts)? Note I already parse incrementally,
  but I still diff by item count.
- The delta protocol is "absolute item index + appended items". Is that
  robust enough? What breaks it? (Consider: file rewritten, compaction, a record
  that mutates an earlier item, parallel writers.)
- Reading is now decoupled from the CLI, but writing still requires
  app-server/CLI processes. Is there a defensible way to make the WRITE path as
  robust as the read path, given we cannot own the agent process?
- Anything about the 150-item window + page-back that will bite us.
- What would you do differently about version skew generally, given the bridge
  depends on three third-party CLIs whose formats change?

Please give: (1) what you think is wrong or risky in the current design,
(2) what you would change in my plan and in what order, (3) anything important
I have not considered.
