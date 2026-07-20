# remote-agents

**Use your coding agents from another device.** remote-agents is a tiny
self-hosted bridge that puts your existing **Codex** and **Claude Code** CLI
sessions on a web page you can open from your phone, tablet, or any browser:
browse every session, open one, read its full history, and continue it — with
model/effort pickers, live streaming, reasoning, command output, diffs,
approvals, token usage, and rich markdown.

It runs on your own machine and talks to your own already-logged-in CLIs. No
accounts to create, nothing sent to a third party, no build step.

---

## Setup (one command)

**Prerequisites**

1. [Node.js](https://nodejs.org) **18 or newer** (`node --version` to check).
2. At least one coding CLI installed **and logged in**:
   - **Codex** — [Codex CLI](https://developers.openai.com/codex/cli), then `codex login`
   - **Claude** — [Claude Code](https://claude.com/product/claude-code), then run `claude` once to sign in

   (Having neither logged in is fine to *start* the server — you'll just see no
   sessions for that provider. Log in and it appears.)

**Run it**

```bash
npx github:akshitcodes/remote-agents
```

That downloads and starts the server. It prints a **QR code** and a set of
pairing URLs, and keeps running until you stop it (Ctrl-C).

The output looks like:

```
  remote-agents is running (bound 0.0.0.0:8484).

  <QR code>

  Open one of these, then Add to Home Screen:
    Anywhere (Tailscale)   http://100.x.y.z:8484/?t=SECRET
    Same Wi-Fi (LAN)       http://192.168.x.y:8484/?t=SECRET
    This computer          http://127.0.0.1:8484/?t=SECRET
```

## Open it

- **On this computer (no phone needed):** open the **"This computer"** link
  (`http://127.0.0.1:<port>/?t=<token>`) in any browser. Works immediately.
- **On your phone (same Wi-Fi):** scan the QR code, or open the **"Same Wi-Fi"**
  link. Then **Share → Add to Home Screen** to get an app icon.
- **On your phone (anywhere / cellular):** see [Access from anywhere](#access-from-anywhere).

The pairing token in the URL is what authorizes the device — open the link once
and it's stored as a cookie.

## Verify it's working

Open the "This computer" link in a browser (you should see the session list), or
from a terminal:

```bash
# reachable + provider list responds (replace <token> with the printed token)
curl -s "http://127.0.0.1:8484/api/models?provider=codex" -H "Authorization: Bearer <token>"
```

A JSON list of models means it's up. The token is also always retrievable:

```bash
cat ~/.codex-phone/config.json     # { "token": "...", "port": 8484 }
```

---

## Access from anywhere

By default the phone must be on the **same Wi-Fi**. To reach it over cellular
from anywhere — with nothing exposed to the public internet — install
[Tailscale](https://tailscale.com) on **both** the computer and the phone and
sign into the same tailnet. remote-agents auto-detects it and prints an
"Anywhere" link + QR.

## Keep it always running (optional)

For a background service that starts on login and restarts if it crashes,
install it persistently first, then set up autostart:

```bash
npm install -g github:akshitcodes/remote-agents   # persistent install
remote-agents install                             # set up OS autostart
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

> The machine must be **awake** to answer the phone (inherent to a self-hosted
> service). Keep a laptop plugged in.

---

## For an AI agent setting this up

This is designed to be set up unattended from the repo link:

1. Confirm Node 18+ (`node --version`) and that `codex` and/or `claude` are on
   `PATH` and logged in.
2. Start it in the background and capture the output to read the token/links:
   ```bash
   npx -y github:akshitcodes/remote-agents serve --port 8484 > /tmp/ra.log 2>&1 &
   # wait for it to listen, then read the token + URLs:
   sleep 3; cat /tmp/ra.log
   ```
3. Verify with the `curl` command in [Verify it's working](#verify-its-working)
   using the token from `~/.codex-phone/config.json`.
4. Hand the user the **"This computer"** URL (open in a browser) and/or the
   **"Same Wi-Fi"** URL for their phone.

Everything is non-interactive: no prompts, config is auto-generated, and a
missing provider CLI degrades gracefully (the server still runs; the other
provider works).

---

## Configuration

- **Token & port** live in `~/.codex-phone/config.json`. A random token is
  generated on first run and reused, so paired devices stay paired.
- Override at launch: `remote-agents serve --host <ip> --port <n> --token <secret>`.
- Default bind is `0.0.0.0` (all interfaces) so localhost, LAN, and tailnet all
  work; the token is the security boundary.

## Troubleshooting

- **`Port 8484 is already in use`** — another copy is running (`remote-agents
  status`), or pick another: `remote-agents serve --port 8585`.
- **No sessions listed for Codex/Claude** — that CLI isn't logged in. Run
  `codex login` / start `claude` once, then reload.
- **Phone can't reach the LAN link** — the phone must be on the same Wi-Fi, and
  some networks block device-to-device traffic; use Tailscale instead.
- **`command not found: node`** — install Node.js 18+.

## Security

- The only way in is a URL containing your pairing token — treat it like a
  password. Anyone with it can drive your agents as you.
- Bind to a trusted network (localhost / LAN / tailnet); never expose the port
  to the public internet.
- Agent output is sanitized with DOMPurify, so untrusted HTML in a model reply
  can't run scripts in your browser.

---

## How it works

A single Node process spawns your provider CLIs and normalizes them to one event
model that the web UI renders:

- **Codex** — runs `codex app-server` (JSON-RPC over stdio); reads sessions from `~/.codex/sessions`.
- **Claude** — runs `claude` in `--output-format stream-json`; reads sessions from `~/.claude/projects`.

Both sit behind a common provider interface (`providers/base.mjs`), so the UI
speaks to either the same way — switch with the Codex/Claude toggle. Adding
another agent = one new `providers/<name>.mjs` implementing
`list / read / send / events`. See `docs/architecture.html` for the full picture.

## Features

Session list (searchable) · full history · resume + live streaming · model &
effort selectors · permission modes · reasoning · live command output · diffs ·
interactive approvals · live token counter · usage & rate limits · new-session
flow · interrupt · rich sanitized markdown. Codex and Claude share all of it.

**Known Claude limits:** approvals are gated via a PreToolUse hook in Agent mode
(works, but hook-based rather than native); the usage panel is thinner than
Codex's (5-hour rate window + session cost — Claude exposes no lifetime-token
count headless).

## License

MIT
