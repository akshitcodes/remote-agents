# remote-agents

remote-agents is a self-hosted phone UI for the Codex, Claude Code, and Grok
sessions already on your computer. It reads each CLI's session files, lets you
continue a thread, streams changes over Server-Sent Events, and can notify an
installed PWA when a turn driven through the bridge finishes.

The bridge runs on your computer and uses your already logged-in agent CLIs. It
does not provide a hosted relay or a shared account.

## macOS setup

You need Node.js 22.5 or newer (the bridge uses Node's built-in SQLite module)
and at least one supported CLI installed and logged in. Install Tailscale on the
Mac, open it, and sign in. The recommended Funnel connection works from anywhere
without installing Tailscale—or anything else—on the phone.

Install the package, then run one setup command:

```bash
npm install -g github:akshitcodes/remote-agents
remote-agents setup
```

`setup` asks one plain question: who should be able to reach this Mac? Press
Enter for the recommended “phone anywhere with the private pairing link” option;
the choice is remembered, so later runs do not ask again. It
generates a private per-install token, chooses and remembers a free port,
checks all three provider CLIs, installs a per-user macOS LaunchAgent, configures
Tailscale Funnel, and verifies that the authenticated app answers through the
stable HTTPS name. First-time certificate issuance can take about 30 seconds, so
the verifier waits up to 75 seconds and says what it is waiting for. Only then
does it print the phone pairing QR.

If Tailscale is missing, signed out, or its HTTPS URL cannot be verified, setup
prints the exact recovery steps and no phone QR. It never substitutes a LAN HTTP
link that looks successful but cannot install the PWA or receive push.

- iPhone/iPad: open in Safari, then **Share -> Add to Home Screen**.
- Android Chrome: tap **Install app** to use Chrome's native install prompt.
- Open the installed app and tap **Enable notifications** when offered.

iPhone and iPad Web Push requires an installed Home Screen web app and iOS or
iPadOS 16.4 or newer. A normal Safari tab cannot opt in.

### Try it without installing a service

This foreground command uses the same Tailscale-first flow and persistent
config, but the local bridge stops when the terminal closes:

```bash
npx github:akshitcodes/remote-agents
```

## Who can reach the Mac?

1. **A phone anywhere with the private pairing link — recommended.** Tailscale
   Funnel provides stable public HTTPS. Only the Mac needs Tailscale; the
   bridge's long random token is still required for every app/API response.
2. **Only devices in your Tailscale account.** Tailscale Serve keeps the HTTPS
   address private, but every phone must install Tailscale and join the same
   account.
3. **People allowed by your Cloudflare policy — advanced.** A stable hostname on your
   own domain with an identity sign-in policy; the cost is Cloudflare account,
   domain/DNS, tunnel, and Access setup.

There is intentionally no LAN HTTP mode. Plain LAN HTTP cannot provide the
secure context needed for PWA installation or Web Push. Cloudflare Quick
Tunnels are also excluded: their hostname changes on restart and Cloudflare
documents that Quick Tunnels do not support Server-Sent Events, which is this
app's live transport.

For the advanced option, first create a named tunnel, route its public hostname
to the bridge, and create a Cloudflare Access self-hosted application with an
Allow policy for that hostname. Then run:

```bash
remote-agents setup --transport cloudflare
remote-agents tunnel --name my-agents --hostname agents.example.com --access-protected
```

The Cloudflare command refuses anonymous Quick Tunnels and withholds its QR
until the stable hostname returns the authenticated app. A Cloudflare Access
login page alone is deliberately not enough: it proves the policy exists, but
not that the app and token work behind it. The URL still contains the bridge
pairing token; treat it like a password.

## Commands

```text
remote-agents                         foreground server + QR
remote-agents setup                   install/start service; Funnel by default
remote-agents setup --transport serve private Tailscale-only access
remote-agents setup --transport cloudflare
remote-agents tailscale               configure/retry saved Tailscale mode
remote-agents tailscale --transport funnel|serve
remote-agents tunnel --name NAME --hostname HOST --access-protected
remote-agents url                     print pairing QR again
remote-agents status                  show service status and pairing URLs
remote-agents start|stop              control the installed service
remote-agents uninstall               remove only the remote-agents service
```

Useful foreground overrides:

```bash
remote-agents serve --host 127.0.0.1 --port 9317
remote-agents serve --token 'at-least-32-random-characters'
```

Values supplied with `--host`, `--port`, or `--token` are persisted. A new
public origin is persisted only after it returns the authenticated app, so a
typo cannot strand an existing installed PWA. Later setup, start, status, and
url commands reuse the saved transport, origin, port, and token. If Tailscale
re-registers the Mac under a different public name, the CLI refuses the change
and explains why installed phones would look broken. `--replace-origin` is the
explicit recovery path; after using it, reinstall the phone PWA and enable
notifications again.

`status` and `url` report the service manager, saved port and transport,
Tailscale connection state, saved/verified public address, and readiness of
Codex, Claude, and Grok. A missing provider does not block setup when another is
ready. If none is installed and signed in, setup stops before installing a
background service.

## Configuration and files

The existing configuration home is reused:

```text
~/.codex-phone/config.json       token, port, public URL, VAPID keypair, options
~/.codex-phone/push.json         browser Web Push subscriptions
~/.codex-phone/logs/             background-service logs
```

The directory is written with mode `0700` and secret-bearing JSON with `0600`.
Set `REMOTE_AGENTS_HOME` to relocate it (also useful for isolated testing).

Supported optional config fields include:

```json
{
  "codexBinary": "/path/to/codex",
  "fileAccess": "project",
  "pushSubject": "mailto:you@example.com"
}
```

`fileAccess` defaults to `project`, which limits the file viewer to a thread's
working directory and sibling Git worktrees. `anywhere` removes that viewer
check. The token is still the real security boundary because a paired client can
drive an agent.

## Notifications

On first server start, a VAPID keypair is generated into the same config. After
the installed PWA opts in, its Push subscription is stored in `push.json`.
Completed turns are encrypted and signed with `web-push`; expired subscriptions
are pruned when a push service returns 404 or 410. The service worker displays
the notification and opens the matching provider/thread when tapped.

Notifications currently cover turns driven through this bridge. The filesystem
watcher follows an external terminal/IDE thread only while a client is viewing
it; remote-agents does not globally monitor every external session while the PWA
is closed.

## Service behavior

On macOS, `setup` creates
`~/Library/LaunchAgents/com.remoteagents.bridge.plist` with `RunAtLoad` and
`KeepAlive`. It records absolute Node/package paths and writes logs below the
config directory. Nothing is installed from npm's `postinstall`; machine changes
happen only after the explicit setup command. The supervised process starts only
the local bridge; `setup` remains the single owner of Funnel/Serve changes,
public verification, and QR output.

Linux retains a best-effort user systemd service. It has not received the same
platform verification as macOS.

Windows is not supported yet. A correct port needs a restart-capable per-user
service/supervisor, Windows-safe command quoting and firewall behavior, and
verification of the native CLIs' session paths and schemas. The detailed scope
is in the repository's
[PORTABLE_PLAN.md](https://github.com/akshitcodes/remote-agents/blob/main/PORTABLE_PLAN.md#windows).

## Security notes

- Pairing through `?t=...` immediately redirects to a clean URL and stores an
  HttpOnly, SameSite cookie. HTTPS pairings also receive the Secure flag.
- Fresh installs generate a 256-bit random pairing token. Repeated bad token
  attempts receive per-client exponential backoff and rate limiting.
- App, API, manifest, service-worker, icon, and vendor responses all require the
  pairing cookie or Bearer token. Unauthenticated responses contain only a
  generic error and no bridge marker, thread data, local paths, or version.
- Responses set clickjacking, MIME-sniffing, referrer, permissions, CSP, and
  same-origin isolation headers; HTTPS responses also set HSTS.
- Anyone with the pairing URL can drive agents with the permissions selected in
  the UI. Rotate the token in config if it leaks, then restart the service.
- Funnel is internet-reachable and the pairing URL is a password. Choose private
  Serve or Cloudflare Access if the token boundary does not fit your threat model.
- Agent Markdown is sanitized before rendering. The file viewer is a convenience
  boundary, not a substitute for authentication.

## How it works

- Codex sessions: `~/.codex/sessions`, with `codex app-server` for active RPC.
- Claude Code sessions: `~/.claude/projects`, using Claude's streaming JSON mode.
- Grok sessions: `~/.grok/sessions`, using its streaming messages protocol.
- Browser transport: authenticated HTTP APIs plus SSE from `/api/events`.
- PWA: one hand-written `public/index.html`, a manifest, and `public/sw.js`; no
  framework or build step.

## Package verification

Before publishing a release:

```bash
npm pack --dry-run
node --check server.mjs
node --check bin/codex-phone.mjs
```

The package allowlist explicitly includes every top-level runtime module,
including `config.mjs` and `onboarding.mjs`, plus providers, the PWA, and public
docs. The internal portability audit is intentionally not published because it
records details of the owner's previous installation. Do not add a
service-installing `postinstall`.

## License

MIT
