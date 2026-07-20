# remote-agents

**Drive your coding agents from your phone.** remote-agents is a tiny self-hosted
bridge that puts your existing **Codex** and **Claude Code** CLI sessions on a
phone-friendly web page: browse every session, open one, read its full history,
and continue it — with model/effort pickers, live streaming, reasoning, command
output, diffs, approvals, token usage, and rich markdown.

It runs on your own machine and talks to your own logged-in CLIs. No accounts to
create, nothing sent to a third party, no build step.

## Quick start (one command)

**Prerequisites:** [Node.js](https://nodejs.org) 18+ and at least one coding CLI
installed and logged in:

- Codex — install the [Codex CLI](https://developers.openai.com/codex/cli), run `codex login`
- Claude — install [Claude Code](https://claude.com/product/claude-code), run `claude` once to sign in

Then, from any machine:

```bash
npx github:akshitcodes/remote-agents
```

It prints a **QR code** and pairing links. Scan the QR with your phone (on the
same Wi-Fi), and **Add to Home Screen** — it behaves like an app. That's it.

> Replace `akshitcodes/remote-agents` with wherever you host the repo.

## Access from anywhere (optional)

By default the phone must be on the **same Wi-Fi**. To reach it over cellular
from anywhere — with nothing exposed to the public internet — install
[Tailscale](https://tailscale.com) on both the computer and the phone and sign
into the same tailnet. remote-agents auto-detects it and prints an "Anywhere"
link + QR.

## Keep it always running (optional)

For a set-and-forget background service that starts on login and restarts if it
crashes:

```bash
npm install -g github:akshitcodes/remote-agents   # persistent install
remote-agents install                              # set up autostart
```

This uses the right mechanism per OS — **launchd** (macOS), **systemd user
service** (Linux), **Task Scheduler** (Windows). Manage it with:

```bash
remote-agents status      # running? + pairing links
remote-agents stop        # stop the service
remote-agents start       # start it
remote-agents url         # print pairing links again
remote-agents uninstall   # remove autostart
```

Note: the machine must be awake to answer the phone (that's inherent to a
self-hosted service). Keep a laptop plugged in.

## Configuration

- **Token & port** are stored in `~/.codex-phone/config.json`. A random pairing
  token is generated on first run and reused, so your phone stays paired.
- Override at launch: `remote-agents serve --host <ip> --port <n> --token <secret>`.
- Default bind is `0.0.0.0` (all interfaces) so LAN + tailnet both work; the
  token is the security boundary.

## Security

- The only way in is a URL containing your pairing token — treat it like a
  password. Anyone with it can drive your agents as you.
- Bind to a trusted network (LAN / tailnet), never expose the port to the public
  internet.
- Agent output is rendered through DOMPurify, so untrusted HTML in a model reply
  can't run scripts in your browser.

## How it works

A single Node process spawns your provider CLIs and normalizes them to one
event model that the web UI renders:

- **Codex** — runs `codex app-server` (JSON-RPC over stdio); reads sessions from `~/.codex/sessions`.
- **Claude** — runs `claude` in `--output-format stream-json`; reads sessions from `~/.claude/projects`.

Both are exposed behind a common provider interface (`providers/base.mjs`), so
the phone speaks to either with the same UI — switch with the Codex/Claude
toggle. See `docs/architecture.html` for the full picture and roadmap.

Adding another agent = one new `providers/<name>.mjs` implementing
`list / read / send / events`.

## Features

Session list (searchable) · full history · resume + live streaming · model &
effort selectors · permission modes · reasoning · live command output · diffs ·
approvals (interactive) · live token counter · usage & rate limits · new-session
flow · interrupt · rich sanitized markdown. Codex and Claude share all of it.

**Known Claude limits:** approvals are gated via a PreToolUse hook in Agent mode
(works, but is hook-based rather than native); the usage panel is thinner than
Codex's (5-hour rate window + session cost — Claude exposes no lifetime-token
count headless).

## License

MIT
