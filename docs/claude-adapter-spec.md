# codex-phone — multi-provider spec (add Claude alongside Codex)

Ground truth for implementing a **Claude Code** provider next to the existing
**Codex** provider, with a Codex/Claude switcher in the UI. All facts below were
verified against the installed CLIs (`codex` 0.144.6, `claude` 2.1.214). Build
against these, not from memory.

## 0. Golden rule

**Do not regress Codex.** Everything that works today must keep working. The
`provider` parameter defaults to `codex` when absent, so existing behavior is
the fallthrough. Test both providers before declaring done.

## 1. Goal / UX

- The list header gets a **provider switcher** (segmented control: `Codex` | `Claude`).
- Switching reloads the session list for that provider and swaps the model list.
- Each session row shows which provider it came from (small badge) when useful.
- Model selector, effort selector, permission modes, reasoning, command output,
  diffs, token counter, usage panel, new-session — all continue to work, now
  sourced from whichever provider is active.
- Everything is normalized so the **existing chat renderer is reused unchanged**.

## 2. Architecture

Refactor `server.mjs` into a thin HTTP/SSE shell plus a provider registry:

```
server.mjs            — HTTP/SSE, auth, routing; dispatches to providers[provider]
providers/codex.mjs   — CodexProvider  (move existing app-server logic here)
providers/claude.mjs  — ClaudeProvider (new)
providers/base.mjs    — optional: shared helpers / interface docs
```

Every route reads `provider` from query (`GET`) or body (`POST`), defaults to
`"codex"`, and calls the matching provider instance. Unknown provider → 400.

### Provider interface

Each provider is a class/object with these async methods:

```js
init()                                   // start any long-lived process
listThreads({ search, cursor })          -> { data:[ThreadSummary], nextCursor }
readThread(id)                           -> { thread: { turns:[{ items:[Item] }] } }
newThread({ cwd, model })                -> { thread: { id } }
send({ threadId, text, model, effort, mode })  // streams events via emit()
interrupt({ threadId, turnId })
models()                                 -> { data:[Model] }
usage()                                  -> { account, rateLimits, usage }   // may be partial
projects()                               -> { projects:[{ path, name, count, lastUsed }] }
```

The provider is constructed with an `emit(event, data)` callback. It calls
`emit("notify", { provider, method, params })` for streaming events and
`emit("approval", { provider, requestId, method, params })` for approvals. The
server tags every emitted event with the provider name and broadcasts to SSE
clients. The UI ignores events whose `provider` !== the active provider (and
whose `threadId` !== the open thread).

## 3. Normalized event + item model (the contract the UI already speaks)

Codex emits these natively (pass them through). The Claude adapter must
**translate** its stream into the same shapes.

**Notify methods** (params always include `threadId`):
- `turn/started`            `{ turn:{ id } }`
- `item/started`            `{ item }`
- `item/agentMessage/delta` `{ itemId, delta }`
- `item/reasoning/summaryTextDelta` `{ itemId, delta }`
- `item/commandExecution/outputDelta` `{ itemId, delta }`
- `item/completed`          `{ item }`
- `turn/diff/updated`       `{ diff }`            (unified diff string; optional)
- `thread/tokenUsage/updated` `{ tokenUsage:{ total:{ totalTokens } } }`
- `account/rateLimits/updated` `{ rateLimits }`
- `turn/completed` / `turn/failed` `{ turn:{ status, error } }`

**Item shapes** (used in `readThread` turns AND in `item/started`/`item/completed`):
- `{ type:"userMessage", content:[{type:"text", text}] }`
- `{ type:"agentMessage", id, text }`
- `{ type:"reasoning", id, summary:[string] }`  (or `content` string)
- `{ type:"commandExecution", id, command, aggregatedOutput, exitCode, status }`
- `{ type:"fileChange", id, changes:[{ path, diff }] }`
- `{ type:"mcpToolCall", id, server, tool }`
- `{ type:"webSearch", id, query }`

`ThreadSummary`: `{ id, preview, name, cwd, gitInfo:{branch}|null, updatedAt (epoch s), provider }`.
`Model`: `{ id, displayName, description, supportedReasoningEfforts:[{reasoningEffort,description}], defaultReasoningEffort, isDefault, hidden }`.

## 4. Verified Claude facts

### CLI flags (`claude`)
- `--print` / `-p` — headless one-shot.
- `--output-format stream-json` + `--verbose` — realtime JSON lines (verbose required with -p + stream-json).
- `--include-partial-messages` — emits token deltas (`stream_event`).
- `--resume <sessionId>` — resume a session; `--continue` / `-c` — most recent; `--fork-session`.
- `--model <alias>` — `opus`, `sonnet`, `fable`, `haiku` (aliases resolve to e.g. `claude-opus-4-8`, `claude-sonnet-5`).
- `--effort <level>` — `low | medium | high | xhigh | max`.
- `--permission-mode <mode>` — `acceptEdits | auto | bypassPermissions | manual | dontAsk | plan`.
- Pass the prompt via `-p "<text>"`. Set `cwd` via child_process `cwd` option (spawn in the project dir).

### Session storage
- `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — one file per session; filename (minus `.jsonl`) is the session id.
- Dir name = cwd with `/` → `-` (e.g. `-Users-you-code-my-project`). Prefer reading the `cwd` field inside the transcript rather than decoding the dir name (paths with real dashes are ambiguous).
- Each line: `{ type, message?, cwd?, sessionId?, timestamp? , ... }`. Relevant `type`s: `user`, `assistant`, `attachment`, plus bookkeeping types to ignore (`queue-operation`, `file-history-snapshot`, `last-prompt`, `ai-title`, `mode`, `file-history-delta`, `frame-link`).
- `message.content` is an array of blocks: `{type:"text",text}`, `{type:"thinking",thinking,signature}`, `{type:"tool_use",id,name,input}`, `{type:"tool_result",tool_use_id,content}`, `{type:"image",source}`.
- Preview = first user text block. updatedAt = file mtime (fast) or last line timestamp.

### stream-json event envelope (live, from `send`)
Each stdout line is one JSON object:
- `{type:"system", subtype:"init", session_id, cwd, model, permissionMode, tools, ...}` — **capture `session_id` here for new sessions.**
- `{type:"system", subtype:"status", status:"requesting"}`
- `{type:"rate_limit_event", rate_limit_info:{ status, resetsAt, rateLimitType:"five_hour", overageStatus, isUsingOverage }}` — map to `account/rateLimits/updated`.
- `{type:"stream_event", event:{...}}` where `event` is a raw Anthropic streaming event:
  - `message_start` → `{message:{usage:{input_tokens,output_tokens,cache_*}}}` → emit `turn/started`.
  - `content_block_start` → `{index, content_block:{type:"text"|"thinking"|"tool_use", id?, name?, input?}}` → emit `item/started` for tool_use; note the block index→kind mapping.
  - `content_block_delta` → `{index, delta:{type:"text_delta",text} | {type:"thinking_delta",thinking} | {type:"input_json_delta",partial_json}}`:
    - `text_delta` → `item/agentMessage/delta {itemId, delta:text}` (itemId = assistant message id).
    - `thinking_delta` → `item/reasoning/summaryTextDelta {itemId, delta:thinking}`.
    - `input_json_delta` → accumulate tool input (for command display); no UI delta needed.
  - `content_block_stop` → finalize that block.
  - `message_delta` → `{delta:{stop_reason}, usage:{output_tokens,...}}` → emit `thread/tokenUsage/updated`.
  - `message_stop`.
- `{type:"assistant", message:{ id, content:[blocks], usage }}` — the assembled assistant message; use to emit `item/completed` for text (agentMessage), thinking (reasoning), and tool_use items.
- `{type:"user", message:{ content:[{type:"tool_result", tool_use_id, content}] }}` — tool output coming back; attach to the matching command/tool item (`item/commandExecution/outputDelta` + later `item/completed`).
- `{type:"result", subtype:"success"|..., result, session_id, total_cost_usd, usage, modelUsage, permission_denials}` → emit `turn/completed` (and final `thread/tokenUsage/updated`).

### Tool → item mapping
- `tool_use.name === "Bash"` → `commandExecution` (command = `input.command`; aggregatedOutput/exitCode from the tool_result).
- `tool_use.name` in `Edit | Write | MultiEdit | NotebookEdit` → `fileChange` (reconstruct a simple diff: for Write, show new content; for Edit, show `input.old_string`→`input.new_string`; path = `input.file_path`).
- otherwise → `mcpToolCall` `{ server: (name.split("__")[1] ?? "tool"), tool: name }`.

## 5. Claude adapter behavior

- `listThreads`: scan `~/.claude/projects/**/*.jsonl`, build ThreadSummary per file (read only the first user line for preview + the transcript `cwd`; use file mtime for `updatedAt`). Sort by updatedAt desc. Support `search` (substring over preview + cwd) and simple `cursor` (offset-based pagination, e.g. cursor = index). `provider:"claude"` on each.
- `readThread(id)`: find the `<id>.jsonl` (search project dirs), parse into turns. Start a new turn at each `user` message that carries real text (skip tool_result-only user lines — those belong to the previous assistant turn). Map blocks to items per §3/§4.
- `newThread({cwd, model})`: don't spawn yet; return a placeholder id? No — Claude needs a real session id. Simplest: spawn a tiny init turn is wasteful. Instead: create the session lazily on first `send` when `threadId` is empty/`"new"`, capturing `session_id` from the init event, then emit a `thread/started`-style notify with the real id so the UI can adopt it. For the `newThread` route, accept `{cwd, model}`, store a pending "draft" keyed by a temp id, and have the UI open a draft chat that calls `send` with `{cwd, draft:true}`; the adapter spawns without `--resume`, reads `session_id` from init, and returns/emits it. Keep this flow minimal.
- `send({threadId, text, model, effort, mode, cwd})`: spawn
  `claude [--resume <threadId>] -p <text> --output-format stream-json --verbose --include-partial-messages --model <model> --effort <effort> --permission-mode <modeMapped>` with `{ cwd }`. Parse stdout lines → emit normalized events. Keep the child in a `Map(threadId→child)` so `interrupt` can kill it.
- `interrupt`: kill the child process for that thread (SIGINT/SIGTERM).
- `models()`: static list — Opus (`opus`), Sonnet (`sonnet`), Fable (`fable`), Haiku (`haiku`); each with `supportedReasoningEfforts` = low/medium/high/xhigh/max, `defaultReasoningEffort:"high"`, Opus `isDefault:true`. Cap note is for build agents only, not this list.
- `usage()`: `account` = `{ type:"chatgpt", email:null, planType:"claude" }` (or read from a rate_limit_event if cached). `rateLimits` = last seen `rate_limit_event` mapped to `{ rateLimits:{ primary:{ usedPercent:null, windowDurationMins:300, resetsAt }, ... } }` — it's a 5-hour window; usedPercent unknown, so the panel should tolerate null (show reset time + status instead of a bar). `usage` = null (Claude has no lifetime-tokens endpoint headless). The UI usage panel must not crash on missing fields.
- `projects()`: distinct cwds from the transcripts (same as Codex).

### Permission-mode mapping (Claude has no sandbox like Codex)
- `read-only` (our "Read-only") → `plan`
- `workspace-write` (our "Agent") → `acceptEdits`
- `danger-full-access` (our "Full access") → `bypassPermissions`
- **v1: Claude approvals are non-interactive** (handled by the permission mode). Do NOT attempt the MCP permission-prompt-tool plumbing now. Note it as a known gap.

## 6. Server route changes

- Add provider registry `{ codex: new CodexProvider(emit), claude: new ClaudeProvider(emit) }`.
- `pickProvider(req, url, body)` → `providers[provider || "codex"]` or 400.
- Update `/api/threads`, `/api/thread`, `/api/models`, `/api/usage`, `/api/projects`,
  `/api/thread/new`, `/api/message`, `/api/interrupt` to dispatch by provider.
- `/api/approval` stays Codex-only for now (Claude v1 has no live approvals).
- `/api/events` unchanged (single SSE stream carries both providers, tagged).

## 7. UI changes (public/index.html)

- Add `state.provider` (default `"codex"`, persisted in prefs).
- Provider switcher in the list header (segmented control). On change: persist,
  reset list + models for that provider, reload.
- Thread `state.active` records its provider; all API calls append
  `provider=<...>` (query for GET, body for POST). New sessions/messages use the
  active provider.
- `initModels()` becomes provider-aware (fetch `/api/models?provider=`).
- SSE `notify`/`approval` handlers: ignore events whose `provider` !== the open
  thread's provider.
- Usage panel: guard every field (Claude returns partial data — null usedPercent,
  null usage). Show reset time + status when the bar % is unavailable.
- Keep all existing rendering (reasoning/command/diff/token) intact — it's shared.

## 8. Definition of done

- Codex path unchanged and still passes the existing flows (list, open, send,
  reasoning, command output, model/effort, usage).
- Claude: switch provider → see Claude sessions → open one → history renders →
  send a message → reply streams (text + thinking + a Bash command block with
  output) → token counter updates → usage panel shows the 5h reset without crashing.
- `node --check server.mjs providers/*.mjs` clean. Server starts. Both providers
  answer `/api/models` and `/api/threads`.
