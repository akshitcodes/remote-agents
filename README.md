# remote-agents

**Use your coding agents from another device.** remote-agents is a tiny
self-hosted bridge that puts your existing **Codex**, **Claude Code**, and
**Grok** CLI sessions on a web page you can open from your phone, tablet, or any
browser: browse every session, open one, read its full history, and continue it
— with model/effort pickers, permission modes, live streaming, reasoning,
command output, diffs, approvals, token usage, rich markdown, a
markdown/code file viewer, and an installable, offline-capable PWA.

It runs on your own machine and talks to your own already-logged-in CLIs. No
accounts to create, nothing sent to a third party, no build step.

---

## Setup (one command)

**Prerequisites**

1. [Node.js](https://nodejs.org) **18 or newer** (`node --version` to check).
2. At least one coding CLI installed **and logged in**:
   - **Codex** — [Codex CLI](https://developers.openai.com/codex/cli), then `codex login`
   - **Claude** — [Claude Code](https://claude.com/product/claude-code), then run `claude` once to sign in
   - **Grok** — the `grok` CLI, then sign in

   (Having none logged in is fine to *start* the server — you'll just see no
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

By default the phone must be on the **same Wi-Fi**. Two ways to reach it from
anywhere (cellular included):

**Option A — Tailscale (most private).** Install [Tailscale](https://tailscale.com)
on **both** the computer and the phone and sign into the same tailnet. Nothing is
exposed to the public internet; remote-agents auto-detects it and prints an
"Anywhere" link + QR. (Note: the raw tailnet URL is HTTP, so the offline PWA
needs `tailscale serve` to get HTTPS.)

**Option B — Cloudflare tunnel (no Tailscale, HTTPS, fast on poor networks).**
Requires [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
(`brew install cloudflared`).

```bash
remote-agents tunnel        # quick tunnel: instant public HTTPS URL + QR (random URL)
```

The URL is HTTPS, so the **installable, offline-capable PWA works on your phone**.
The quick-tunnel URL changes each run; for a **stable** URL, use your own domain
on Cloudflare (free) with a named tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create remote-agents
cloudflared tunnel route dns remote-agents agents.your-domain.com
remote-agents tunnel --name remote-agents --hostname agents.your-domain.com
```

> A tunnel exposes the server publicly behind Cloudflare — the **token is the
> only lock**, so keep the link private. For identity-based access (email code /
> Google), put **Cloudflare Access** (free) in front of the tunnel.

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
- **Push keys** are generated once into the same file (`vapid`), so paired phones
  stay subscribed. Set `pushSubject` there to your own `mailto:` or `https:` URL
  if you like — it is the contact the push service sees. It must be real: Apple
  rejects the whole request with `403 BadJwtToken` for a made-up domain.
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
- Prefer a trusted network (localhost / LAN / tailnet). If you use
  `remote-agents tunnel`, the server is reachable publicly behind Cloudflare and
  the **token is the only lock** — keep the link private, and add **Cloudflare
  Access** for an identity gate.
- Agent output is sanitized with DOMPurify, so untrusted HTML in a model reply
  can't run scripts in your browser.
- The file viewer is scoped to each thread's project — its `cwd` plus every git
  worktree of the same repository, so files an agent wrote in a worktree open
  normally. Anything else is rejected. This is a convenience boundary, not a
  security one: the pairing token already lets anyone drive an agent in Full
  Access. Set `fileAccess: "anywhere"` in `~/.codex-phone/config.json` to drop it.

---

## How it works

A single Node process spawns your provider CLIs and normalizes them to one event
model that the web UI renders:

- **Codex** — runs `codex app-server` (JSON-RPC over stdio); reads sessions from `~/.codex/sessions`.
- **Claude** — runs `claude` in `--output-format stream-json`; reads sessions from `~/.claude/projects`.
- **Grok** — runs `grok` in `--output-format streaming-messages-json` (Anthropic wire format); reads sessions from `~/.grok/sessions`.

All three sit behind a common provider interface (`providers/base.mjs`), so the
UI speaks to each the same way — switch with the Codex/Claude/Grok toggle. Adding
another agent = one new `providers/<name>.mjs` implementing
`list / read / send / events`. See `docs/architecture.html` for the full picture.

## Features

Session list (searchable, sorted by last activity) · full history · resume + live
streaming · model & effort selectors · **provider-specific permission modes** ·
reasoning · live command output · diffs · **markdown/code file viewer**
(syntax-highlighted — tap any file path an agent links) · interactive approvals · **queue / steer** messages
mid-turn · stop · live token counter · usage & rate limits · new-session flow ·
**live running-thread status** · rich sanitized
markdown. Codex, Claude, and Grok share all of it.

**Turns you started somewhere else.** A turn begun in a terminal, in an IDE, or
from another device belongs to a different process, so none of its output
reaches this bridge. Instead the server watches that CLI's own session file for
the threads you have open, and the app re-reads the thread whenever it moves —
so a thread running on your Mac streams to your phone (about a second behind)
instead of sitting frozen until you close and reopen it. Those threads are
badged **running** in the session list too, which is read off disk, so it is
right even for turns that started before you opened the app.

**Notifications.** Turn them on in **Usage → Notifications** and your phone buzzes
when a turn finishes — thread title plus the start of the reply, tap to jump
straight into that chat. Works for all three providers, with the app closed. This
is Web Push, so on iPhone it needs the **Home Screen install** (iOS 16.4+) — no
native app, no third-party service; notifications go through Apple's own push
service, signed with a VAPID key generated on first run.

**Installable PWA + offline.** Add it to your home screen; it launches instantly
and recently-opened chats are readable **offline** (cached in IndexedDB), then
re-sync when you're back online. You only need the network to *send*.

This covers **both** kinds of outage — your phone having no signal, *and* the Mac
being asleep or its tunnel down. The second one is the sneaky case: a proxy like
Cloudflare answers with a real HTTP error page ("tunnel not responding"), which
looks like a perfectly successful response, so the app treats a 5xx from the
proxy as an outage rather than rendering it. Either way you get the cached app
and your saved chats, with a badge saying which side is down — `Offline` or
`Mac offline` — and it reconnects and refreshes by itself when the Mac returns.

**Permission modes** map to each CLI's real controls — Codex: Read Only /
Auto / Full Access; Claude: Manual / Accept edits / Plan / Bypass; Grok: Manual /
Bypass. **Known Claude limit:** approvals are gated via a PreToolUse hook in
Manual mode (works, but hook-based rather than native).

## License

MIT
