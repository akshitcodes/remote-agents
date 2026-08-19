# Portable installation plan

> **Implementation update (2026-08-19):** Live testing superseded the
> Serve-first transport decision below. Tailscale Funnel is now the default
> because only the Mac needs Tailscale and the phone installs nothing. Setup
> distinguishes not installed, installed-but-stopped/signed-out, and connected;
> allows up to 75 seconds for first-time certificate issuance; refuses a changed
> public address without `--replace-origin`; and offers private Serve plus a
> Cloudflare named tunnel as the two alternatives.

## Starting point and findings

The current branch already contains a partial portability pass: `package.json`
has a `remote-agents` bin, `bin/codex-phone.mjs` can generate a token and write a
LaunchAgent, and `push.mjs` plus the PWA contain an initial Web Push path. The
work below treats those as code to harden, not as completed functionality.

### Authentication and configuration

- `server.mjs:497-505` accepts either the `cxp_session` cookie or an
  `Authorization: Bearer ...` header. `server.mjs:922-928` exchanges a matching
  `?t=` pairing query for the cookie and redirects to remove the token from the
  address bar. There is no literal shared token in the current source; the
  effective token is the value passed to `startServer()`.
- `bin/codex-phone.mjs:28-70` reads `~/.codex-phone/config.json`, generates a
  nine-byte base64url token on first run, and reuses it. The live installation's
  config contains `token`, `port: 8484`, and a VAPID keypair. Secrets are not
  copied into this plan.
- The same config is read independently by `bin/codex-phone.mjs`,
  `server.mjs:605-611`, `providers/codex.mjs:51-57`, and `push.mjs:17-60`.
  This is the existing persistence mechanism and should be reused, but the path
  and JSON I/O should be centralized so testing and file permissions are
  consistent. A test-only/advanced `REMOTE_AGENTS_HOME` override will permit an
  isolated config directory without changing the user's home.
- Fresh installs still fall back to the fixed port `8484` in
  `bin/codex-phone.mjs:70,413` and `server.mjs:999`. The config writer uses
  default filesystem modes, so the token and VAPID private key can be
  world-readable depending on umask. Argument ports and tokens are not
  validated, and `startServer()` accepts an empty token.
- `push.mjs:25` uses the author's GitHub repository as the default VAPID contact.
  This is a real URL and therefore works, but it is project-owner-specific; it
  should be represented as the package support URL and remain overridable with
  `pushSubject` rather than being an unexplained personal constant.

### Port, paths, tunnel, and manually installed services

- The live bridge is outside this worktree at
  `/Users/akshitharjai/Code/codex-phone` and is bound to `8484`. It must remain
  untouched.
- `/Users/akshitharjai/Library/LaunchAgents/com.codexphone.server.plist` runs an
  absolute Homebrew Node binary plus
  `/Users/akshitharjai/Code/codex-phone/bin/codex-phone.mjs serve`, keeps it
  alive, and writes logs below `/Users/akshitharjai/.codex-phone/logs`.
- `/Users/akshitharjai/Library/LaunchAgents/com.remoteagents.tunnel.plist` runs
  `/opt/homebrew/bin/cloudflared tunnel run --url http://localhost:8484
  remote-agents`. The tunnel logs show the owner-specific public hostname
  `agents.akshit.codes`. The repository has no checked-in copy of either live
  plist and no historical install transcript; they are currently loaded
  per-user LaunchAgents. The portable CLI uses `launchctl bootstrap`/`bootout`
  in `bin/codex-phone.mjs:280-320`, but its label is still
  `com.codexphone.server`, which would collide with this live service.
- `docs/architecture.html:407-438` contains a concrete tailnet IP and port
  (`100.103.140.59:8484`). It is explanatory documentation, not runtime input,
  but it is owner-specific and should be replaced with example values.
- Provider state is intentionally derived from the current user's home:
  `~/.codex/sessions` (`codex-rollout.mjs`, `watch.mjs`),
  `~/.claude/projects` (`providers/claude.mjs`, `watch.mjs`), and
  `~/.grok/sessions` (`providers/grok.mjs`, `watch.mjs`). These are portable
  home-relative paths, not author-specific absolute paths. Codex additionally
  checks the macOS ChatGPT-bundled binary at
  `/Applications/ChatGPT.app/Contents/Resources/codex` before falling back to
  `codex` on `PATH`; `codexBinary` in the existing config overrides it.

### Packaging gaps

- `package.json:6-8` has the required executable mapping and the bin file has a
  shebang, so both `npm install -g` and `npx` can expose `remote-agents`.
- The package claims Node 18 support, but `codex-titles.mjs` imports built-in
  `node:sqlite`, whose synchronous API is available only in newer Node releases.
  Raise the engine/documented floor to Node 22.5 instead of publishing a package
  that fails at import time on its stated minimum.
- The current `files` allowlist is broken. An `npm pack --dry-run` includes
  `server.mjs` but omits top-level runtime imports including `push.mjs`,
  `watch.mjs`, `owners.mjs`, `codex-rollout.mjs`, and `codex-titles.mjs`; the
  published package would fail at startup.
- `qrcode-terminal` is justified for a terminal QR with no build step.
  `web-push` is justified because implementing interoperable VAPID JWT signing,
  payload encryption, and push-service request handling correctly is security-
  sensitive and not provided by Node's standard library. No further runtime
  dependency is planned. Existing provider dependencies remain unchanged.
- `postinstall` must not start processes, modify shell profiles, create
  LaunchAgents, configure Tailscale/Cloudflare, or inspect agent sessions. Global
  install should only place package files; the explicit `remote-agents setup`
  command owns machine changes.

## First-run design

1. `remote-agents` remains the safe foreground command. On a fresh config it
   creates `~/.codex-phone` with owner-only permissions, generates a 256-bit
   pairing token, asks the OS for a free port, persists both, starts the bridge,
   and prints a QR plus all usable URLs. `--port`, `--host`, and `--token` remain
   explicit overrides and are validated before persistence.
2. `remote-agents setup` is the macOS one-command persistent setup after a
   global install. It creates the same config, installs a new non-colliding
   `com.remoteagents.bridge` LaunchAgent, waits for that service to listen, and
   prints the QR. It never runs from `postinstall`, and it refuses an ephemeral
   `npx` path because that path disappears.
3. Setup presents three reachability choices and defaults to Tailscale Funnel.
   Enter accepts the default; `--transport tailscale|cloudflare` makes it
   non-interactive. The choice is remembered immediately, including when setup
   pauses for a missing external prerequisite, so retrying skips the question.
4. For Tailscale, setup configures background Funnel or private Serve, then makes an authenticated
   request through the stable `https://*.ts.net` origin. It prints a phone QR
   only after that request returns this app. If Tailscale is missing, signed out,
   or unreachable, setup prints exact install/sign-in/retry steps and no LAN QR.
5. The verified HTTPS base URL is persisted in the existing config.
   `remote-agents url` re-verifies it and reproduces the pairing QR without
   rotating the token. The service always reads the persisted origin,
   port/token, and VAPID keys; restarts do not break existing pairings.
6. The authenticated `/` response injects a small server-rendered onboarding
   card selected from the request User-Agent. iOS/iPadOS gets Safari's
   **Share -> Add to Home Screen** instructions. Android gets an Install button
   wired to `beforeinstallprompt`. Other platforms get a concise browser-menu
   fallback. Client-side standalone detection hides install onboarding after
   launch from the installed app.
7. On the first standalone launch, a second card offers notifications. Permission
   is requested only from a button click. The existing Usage-screen notification
   controls remain available for later changes.

## Reaching the computer: final ranking

There are exactly three supported choices. A five-item transport menu moves
infrastructure design onto a new user and makes it too easy to choose an origin
that silently breaks the installed PWA.

1. **Tailscale Funnel (recommended):** stable public HTTPS on Wi-Fi or cellular;
   only the Mac needs Tailscale and the phone installs nothing.
2. **Tailscale Serve (private):** only devices in the same Tailscale account can
   connect, so the phone must also install and sign in to Tailscale.
3. **Cloudflare named tunnel + Access (advanced):** stable hostname on the
   user's own domain with identity-aware access control, with the cost of a
   Cloudflare account, DNS, tunnel credentials, and Access policy setup.

There is no LAN evaluation option. Ordinary `http://192.168...` is not a secure
context on a phone, so install and push would fail. Cloudflare Quick Tunnels are
also excluded from the CLI: their origin changes on restart, breaking the PWA,
cookie and push subscription, and Cloudflare documents that Quick Tunnels do
not support SSE.

## Service supervision

- **macOS:** generate a per-user LaunchAgent only when `setup`/`install` is
  explicitly invoked. Use the package's absolute CLI path, a stable Node launcher
  where possible, `RunAtLoad`, `KeepAlive`, owner-only plist permissions, and
  logs under the existing config directory. Check every `launchctl` result and
  report failure instead of claiming success. `uninstall` removes only the new
  `com.remoteagents.bridge` job and plist. It never touches
  `com.codexphone.server` or `com.remoteagents.tunnel`.
- **Linux:** retain the current user-systemd backend as best-effort/documented,
  but macOS is the verified platform for this phase.
- **Windows:** do not advertise the existing Task Scheduler stub as supported;
  see the dedicated section below.

## Notifications

Web Push requires all of the following, none of which can be replaced by merely
calling `Notification.requestPermission()`:

- a VAPID public/private keypair generated once per installation and persisted
  in `~/.codex-phone/config.json`;
- a service worker and manifest served from a stable HTTPS origin;
- an explicit browser permission gesture and `PushManager.subscribe()` using the
  public VAPID key;
- authenticated subscribe/unsubscribe endpoints and durable server-side storage
  of the returned endpoint plus encryption keys;
- a server send path that encrypts/signs the payload, prunes expired 404/410
  subscriptions, and a service-worker `push`/`notificationclick` handler.

The branch already has each code path in initial form across `push.mjs`,
`server.mjs:369-457,702-747`, `public/index.html:2473-2580`, and
`public/sw.js:63-108`. The work is to secure its config/subscription files,
package the module, put opt-in in the promised onboarding sequence, and verify
the HTTP endpoints without claiming a real-device delivery test. Notifications
currently originate from turns driven by this bridge; watching every external
terminal/IDE session while no PWA is connected would require a new global
session watcher and is out of scope for this portability pass.

On iPhone/iPad, Web Push is available only to a Home Screen web app on iOS/iPadOS
16.4 or newer. Safari tab permission alone is not enough. Android/Chromium can
use `beforeinstallprompt`, but that event is not available on iOS.

## Windows

This is a real project, not a small conditional-path change. The current
`windowsAgent()` only creates an on-logon Task Scheduler entry and explicitly
does not restart the bridge after a crash. A supported port needs:

- a real per-user supervisor choice and lifecycle (`schtasks` with restart
  policy, a Windows Service wrapper, or a documented external supervisor), plus
  install/start/stop/status/uninstall behavior and logs equivalent to launchd;
- robust Windows quoting for Node, the global package path, the generated Claude
  hook command, and paths containing spaces;
- firewall prompts/rules for LAN binding and a tested secure remote transport;
- verification of each installed Windows CLI and its session schema/location.
  The current code assumes Node's `homedir()` joined with `.codex/sessions`,
  `.claude/projects`, and `.grok/sessions` (normally
  `%USERPROFILE%\\.codex\\sessions`, `%USERPROFILE%\\.claude\\projects`, and
  `%USERPROFILE%\\.grok\\sessions`), but those assumptions and concurrent-file
  behavior have not been tested against native Windows releases;
- Windows integration tests for process spawning, interruption, filesystem
  watching, sleep/resume, Task Scheduler/service recovery, and uninstall.

This phase will make Windows report itself as unsupported instead of presenting
the unverified Task Scheduler stub as production-ready.

## Implementation sequence

1. Add a shared config module, migrate all existing readers/writers to it, secure
   file modes, validate overrides, generate a stronger token, and choose/persist
   a free first-run port.
2. Harden the CLI and macOS LaunchAgent lifecycle, add `setup` and verified
   Tailscale Funnel/Serve support, reject Quick Tunnels, and fix stale-config QR output.
3. Add the server-rendered platform onboarding and the installed-PWA notification
   offer while preserving the one-file, no-build client.
4. Fix the npm package allowlist/metadata, remove owner-specific documentation
   examples, and rewrite installation/connectivity documentation around the
   actual secure transport boundary.
5. Syntax-check every modified JavaScript module and the extracted inline client
   script; dry-run the package; start one isolated server with a fresh temporary
   home on an explicit 9000-9500 port; verify config/token/VAPID generation, QR
   output, auth redirect, landing page, iOS text, Android text, manifest/service
   worker, and push endpoints; stop only that exact spawned process.

## Out of scope

- Provisioning a shared relay, bundled public hostname, Cloudflare account/domain,
  Tailscale account, TLS certificate authority, or identity provider. Those are
  external services and security/operational commitments, not local packaging.
- A native iOS/Android app. The requirement is satisfiable with a PWA, subject to
  secure-origin and iOS version/install constraints.
- End-to-end push delivery without a real subscribed phone and push service. The
  server/browser path can be exercised locally; delivery must be device-tested.
- Reworking provider protocols or rewriting the single-file client into a
  framework/build pipeline. Neither is required for portable installation.
- Monitoring every CLI session globally for external-turn notifications while
  the PWA is closed. The existing watcher is interest-driven for performance;
  expanding it needs separate design and load testing.
- Publishing to npm, installing globally, configuring the owner's live services,
  or modifying the owner's other checkout. The result remains an uncommitted
  reviewable worktree diff.
