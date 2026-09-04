import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/xterm-addon-fit.mjs";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const provider = params.get("provider") || "codex";
const threadId = params.get("threadId") || "";
const embedded = params.get("embedded") === "1";
document.body.classList.toggle("embedded", embedded);
let enrollmentCapability = new URLSearchParams(location.hash.slice(1)).get("enroll") || "";
if (enrollmentCapability) { history.replaceState(null, "", location.pathname + location.search); }

let socket = null;
let terminal = null;
let fitAddon = null;
let resizeObserver = null;
let inputSequence = 0;
let fallbackJob = null;
let terminalBackendAvailable = false;
let terminalMode = null;
let scannerStream = null;
let scannerFrame = 0;
let qrDecoderPromise = null;
const TERMINAL_MODE_KEY = "remote-agents-terminal-mode-v1";

function setError(message = "") {
  $("gateError").textContent = message;
  $("gateError").classList.toggle("hidden", !message);
}

function gate({ title, copy, action, disabled = false, code = false, label = false, onclick = null }) {
  $("gate").classList.remove("hidden");
  $("modeSwitch").classList.add("hidden");
  $("addDevice").classList.add("hidden");
  $("terminalShell").classList.add("hidden");
  $("fallback").classList.add("hidden");
  $("gateTitle").textContent = title;
  $("gateCopy").textContent = copy;
  $("codeField").classList.toggle("hidden", !code);
  $("scanQr").classList.toggle("hidden", !code);
  $("labelField").classList.toggle("hidden", !label);
  $("gateAction").textContent = action;
  $("gateAction").disabled = disabled;
  $("gateAction").onclick = onclick;
  $("connection").textContent = "Locked";
  $("connection").classList.remove("live");
}

function loadQrDecoder() {
  if (globalThis.jsQR) { return Promise.resolve(globalThis.jsQR); }
  if (qrDecoderPromise) { return qrDecoderPromise; }
  qrDecoderPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/jsqr.js";
    script.onload = () => globalThis.jsQR ? resolve(globalThis.jsQR) : reject(new Error("QR scanner failed to load"));
    script.onerror = () => reject(new Error("QR scanner failed to load"));
    document.head.append(script);
  });
  return qrDecoderPromise;
}

function stopScanner() {
  cancelAnimationFrame(scannerFrame);
  scannerFrame = 0;
  scannerStream?.getTracks().forEach((track) => track.stop());
  scannerStream = null;
  $("scannerVideo").srcObject = null;
  if ($("scanDialog").open) { $("scanDialog").close(); }
}

function acceptEnrollmentQr(value) {
  let target;
  try { target = new URL(value); } catch { return false; }
  if (target.origin !== location.origin) { return false; }
  const isHandoff = target.pathname === "/api/terminal/handoff" && !!target.searchParams.get("handoff");
  const enrollment = target.pathname === "/terminal" && new URLSearchParams(target.hash.slice(1)).get("enroll");
  if (!isHandoff && !enrollment) { return false; }
  stopScanner();
  location.assign(target.toString());
  return true;
}

async function scanEnrollmentQr() {
  setError();
  if (!navigator.mediaDevices?.getUserMedia) {
    return setError("Camera scanning is unavailable in this browser. Enter the enrollment code instead.");
  }
  $("scannerStatus").textContent = "Starting camera…";
  $("scanDialog").showModal();
  try {
    const decoder = await loadQrDecoder();
    scannerStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    const video = $("scannerVideo");
    video.srcObject = scannerStream;
    await video.play();
    $("scannerStatus").textContent = "Looking for this bridge’s enrollment QR…";
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    let lastRead = 0;
    const readFrame = (now) => {
      if (!scannerStream || !$("scanDialog").open) { return; }
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && now - lastRead >= 120) {
        lastRead = now;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width && height) {
          canvas.width = width;
          canvas.height = height;
          context.drawImage(video, 0, 0, width, height);
          const pixels = context.getImageData(0, 0, width, height);
          const result = decoder(pixels.data, width, height, { inversionAttempts: "dontInvert" });
          if (result?.data) {
            if (acceptEnrollmentQr(result.data)) { return; }
            $("scannerStatus").textContent = "That is not a Remote Agents enrollment QR.";
          }
        }
      }
      scannerFrame = requestAnimationFrame(readFrame);
    };
    scannerFrame = requestAnimationFrame(readFrame);
  } catch (error) {
    stopScanner();
    setError(error.name === "NotAllowedError"
      ? "Camera access was denied. Allow camera access or enter the enrollment code instead."
      : `${error.message}. Enter the enrollment code instead.`);
  }
}

function preferredTerminalMode() {
  const saved = localStorage.getItem(TERMINAL_MODE_KEY);
  if (saved === "command" || saved === "interactive") { return saved; }
  return matchMedia("(max-width: 600px)").matches ? "command" : "interactive";
}

function closeInteractiveSocket() {
  const connection = socket;
  socket = null;
  if (connection && connection.readyState < WebSocket.CLOSING) {
    connection.close(4000, "switched to command mode");
  }
}

function updateModeSwitch() {
  $("modeSwitch").classList.remove("hidden");
  for (const button of $("modeSwitch").querySelectorAll("[data-terminal-mode]")) {
    const mode = button.dataset.terminalMode;
    button.classList.toggle("on", mode === terminalMode);
    button.setAttribute("aria-pressed", String(mode === terminalMode));
    button.disabled = mode === "interactive" && !terminalBackendAvailable;
    button.title = button.disabled ? "Interactive PTY is unavailable on this bridge" : "";
  }
}

function showCommandMode(reason = "Typing stays on this device. The command is sent only when you press Enter.") {
  closeInteractiveSocket();
  terminalMode = "command";
  $("gate").classList.add("hidden");
  $("terminalShell").classList.add("hidden");
  $("fallback").classList.remove("hidden");
  $("fallbackReason").textContent = reason;
  $("connection").textContent = "Command mode";
  $("connection").classList.remove("live");
  updateModeSwitch();
  $("commandInput").focus();
}

async function selectTerminalMode(mode, { persist = true, unavailableReason = "" } = {}) {
  if (mode === "interactive" && !terminalBackendAvailable) {
    showCommandMode(unavailableReason || "Interactive PTY is unavailable on this bridge. Commands still run normally after Enter.");
    return;
  }
  if (persist) { localStorage.setItem(TERMINAL_MODE_KEY, mode); }
  if (mode === "command") {
    showCommandMode();
    return;
  }
  terminalMode = "interactive";
  updateModeSwitch();
  await connectTerminal();
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || `Request failed (${response.status})`);
    error.code = value.code;
    error.status = response.status;
    throw error;
  }
  return value;
}

function deviceLabel() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "device";
  return `${platform} browser`;
}

async function register() {
  const capability = enrollmentCapability || $("enrollmentCode").value.trim();
  if (!capability) { return setError("Enter the enrollment code shown on the bridge Mac."); }
  setError();
  $("gateAction").disabled = true;
  $("gateAction").textContent = "Waiting for your passkey…";
  try {
    const ceremony = await api("/api/terminal/register/options", {
      capability,
      label: $("deviceLabel").value.trim() || deviceLabel(),
    });
    const response = await globalThis.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: ceremony.options });
    await api("/api/terminal/register/verify", { ceremonyId: ceremony.ceremonyId, response });
    enrollmentCapability = "";
    await initialize();
  } catch (error) {
    setError(error.message);
    $("gateAction").disabled = false;
    $("gateAction").textContent = "Create passkey";
  }
}

async function unlock() {
  setError();
  $("gateAction").disabled = true;
  $("gateAction").textContent = "Waiting for your passkey…";
  try {
    const ceremony = await api("/api/terminal/auth/options", {});
    const response = await globalThis.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: ceremony.options });
    await api("/api/terminal/auth/verify", { ceremonyId: ceremony.ceremonyId, response });
    await initialize();
  } catch (error) {
    setError(error.message);
    $("gateAction").disabled = false;
    $("gateAction").textContent = "Unlock with passkey";
  }
}

async function beginLocalSetup() {
  setError();
  $("gateAction").disabled = true;
  $("gateAction").textContent = "Opening local setup…";
  try {
    const handoff = await api("/api/terminal/local-handoff", { provider, threadId, embedded });
    location.assign(handoff.url);
  } catch (error) {
    setError(error.message);
    $("gateAction").disabled = false;
    $("gateAction").textContent = "Set up on this Mac";
  }
}

async function routeToCanonicalOrigin(canonicalOrigin) {
  const handoff = await api("/api/terminal/browser-handoff", { provider, threadId, embedded });
  const target = new URL(handoff.url);
  if (target.origin !== canonicalOrigin) { throw new Error("The bridge returned an unexpected terminal address"); }
  location.replace(target.toString());
}

async function addTrustedDevice() {
  $("deviceError").classList.add("hidden");
  $("addDevice").disabled = true;
  try {
    const handoff = await api("/api/terminal/device-handoff", { provider, threadId });
    $("deviceLink").value = handoff.url;
    $("deviceCode").textContent = handoff.code || "—";
    $("deviceQr").innerHTML = handoff.qr || "";
    $("shareDeviceLink").style.display = navigator.share ? "inline-flex" : "none";
    $("deviceDialog").showModal();
  } catch (error) {
    $("deviceError").textContent = error.message;
    $("deviceError").classList.remove("hidden");
    if (!$("deviceDialog").open) { $("deviceDialog").showModal(); }
  } finally {
    $("addDevice").disabled = false;
  }
}

function terminalDimensions() {
  return { cols: terminal?.cols || 100, rows: terminal?.rows || 30 };
}

async function connectTerminal() {
  const issued = await api("/api/terminal/ticket", { provider, threadId });
  $("context").textContent = `${issued.context.title} · ${issued.context.cwd}`;
  document.title = `${issued.context.title} · Terminal`;
  $("gate").classList.add("hidden");
  $("fallback").classList.add("hidden");
  $("terminalShell").classList.remove("hidden");
  terminalMode = "interactive";
  updateModeSwitch();

  if (!terminal) {
    terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: matchMedia("(max-width: 600px)").matches ? 13 : 14,
      lineHeight: 1.18,
      scrollback: 10000,
      theme: { background: "#070a0e", foreground: "#e5eaf1", cursor: "#69c66b", selectionBackground: "#56915f66" },
    });
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open($("terminal"));
    terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data, seq: ++inputSequence }));
      }
    });
    resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", ...terminalDimensions() }));
      }
    });
    resizeObserver.observe($("terminal"));
  }
  requestAnimationFrame(() => fitAddon.fit());

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const previousSocket = socket;
  if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) {
    previousSocket.close(4000, "reconnecting");
  }
  const connection = new WebSocket(`${protocol}//${location.host}/api/terminal/ws`);
  socket = connection;
  $("terminalStatus").textContent = "Connecting securely…";
  $("reconnect").classList.add("hidden");
  connection.addEventListener("open", () => connection.send(JSON.stringify({ type: "auth", ticket: issued.ticket, ...terminalDimensions() })));
  connection.addEventListener("message", (event) => {
    if (socket !== connection) { return; }
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type === "ready") {
      terminal.reset();
      if (frame.replay) { terminal.write(frame.replay); }
      $("connection").textContent = "Connected";
      $("connection").classList.add("live");
      $("terminalStatus").textContent = frame.cwd;
      terminal.focus();
    } else if (frame.type === "output") {
      terminal.write(frame.data || "");
    } else if (frame.type === "exit") {
      terminal.writeln(`\r\n[process exited ${frame.exitCode ?? ""}]`);
      $("terminalStatus").textContent = "Shell exited";
    } else if (frame.type === "error") {
      terminal.writeln(`\r\n[${frame.message || "terminal error"}]`);
      $("terminalStatus").textContent = frame.message || "Terminal error";
    }
  });
  connection.addEventListener("close", (event) => {
    if (socket !== connection) { return; }
    $("connection").textContent = "Disconnected";
    $("connection").classList.remove("live");
    $("terminalStatus").textContent = event.reason || "Terminal disconnected";
    $("reconnect").classList.remove("hidden");
  });
}

async function runFallback(event) {
  event.preventDefault();
  const command = $("commandInput").value.trim();
  if (!command || fallbackJob) { return; }
  $("commandOutput").textContent += `\n$ ${command}\n`;
  $("commandInput").disabled = true;
  try {
    fallbackJob = await api("/api/terminal/run", { provider, threadId, command });
    let offset = fallbackJob.nextOffset || 0;
    if (fallbackJob.output) { $("commandOutput").textContent += fallbackJob.output; }
    while (["running", "stopping"].includes(fallbackJob.state)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      fallbackJob = await api(`/api/terminal/status?id=${encodeURIComponent(fallbackJob.id)}&offset=${offset}`);
      offset = fallbackJob.nextOffset || offset;
      if (fallbackJob.output) { $("commandOutput").textContent += fallbackJob.output; }
      $("commandOutput").scrollTop = $("commandOutput").scrollHeight;
    }
    $("commandOutput").textContent += `\n[exit ${fallbackJob.exitCode ?? "unknown"}]\n`;
    $("commandInput").value = "";
  } catch (error) {
    $("commandOutput").textContent += `\n[${error.message}; command status may be uncertain]\n`;
  } finally {
    fallbackJob = null;
    $("commandInput").disabled = false;
    $("commandInput").focus();
  }
}

async function initialize() {
  if (!threadId) {
    return gate({ title: "No project selected", copy: "Open the terminal from a chat so the bridge can choose its project folder.", action: "Back to agents", onclick: () => location.assign("/") });
  }
  $("context").textContent = `${provider} · ${threadId}`;
  try {
    const status = await api("/api/terminal/security/status");
    if (status.access.origin && location.origin !== status.access.origin) {
      await routeToCanonicalOrigin(status.access.origin);
      return;
    }
    if (!status.access.enabled) {
      const bridgeMacBrowser = /Macintosh|Mac OS X/i.test(navigator.userAgent) && (navigator.maxTouchPoints || 0) < 2;
      return gate(!bridgeMacBrowser
        ? { title: "Finish setup on the bridge Mac", copy: "For safety, terminal access can only be turned on from a browser running on the bridge Mac. Open this chat there, tap the terminal icon, and choose Set up on this Mac.", action: "Check again", onclick: initialize }
        : { title: "Turn on secure terminal", copy: "This opens a one-time setup through this Mac only. You’ll create a passkey before any command can run.", action: "Set up on this Mac", onclick: beginLocalSetup });
    }
    if (!status.access.enrolled || enrollmentCapability) {
      $("deviceLabel").value ||= deviceLabel();
      return gate({ title: "Trust this device", copy: "Enter the one-time code created locally, then create a passkey with Face ID, Touch ID, Windows Hello, or your device PIN.", action: "Create passkey", code: !enrollmentCapability, label: true, onclick: register });
    }
    if (!status.access.unlocked) {
      return gate({ title: "Unlock project terminal", copy: `Verify the passkey for ${status.access.device?.label || "this device"}. The unlock expires after inactivity.`, action: "Unlock with passkey", onclick: unlock });
    }
    $("addDevice").classList.remove("hidden");
    terminalBackendAvailable = !!status.backend.available;
    if (!terminalBackendAvailable) {
      $("context").textContent = `${provider} · project command mode`;
      showCommandMode(status.backend.reason || "Interactive PTY is unavailable on this bridge. Commands still run normally after Enter.");
      return;
    }
    await selectTerminalMode(preferredTerminalMode(), { persist: false });
  } catch (error) {
    gate({ title: "Terminal unavailable", copy: "The bridge could not establish secure terminal access.", action: "Try again", onclick: initialize });
    setError(error.message);
  }
}

$("commandForm").addEventListener("submit", runFallback);
$("scanQr").addEventListener("click", scanEnrollmentQr);
$("closeScanner").addEventListener("click", stopScanner);
$("scannerCancel").addEventListener("click", stopScanner);
$("scanDialog").addEventListener("cancel", (event) => { event.preventDefault(); stopScanner(); });
$("addDevice").addEventListener("click", addTrustedDevice);
$("copyDeviceLink").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("deviceLink").value);
  $("copyDeviceLink").textContent = "Copied";
  setTimeout(() => { $("copyDeviceLink").textContent = "Copy link"; }, 1500);
});
$("shareDeviceLink").addEventListener("click", () => navigator.share?.({
  title: "Remote Agents terminal setup",
  text: "Trust this device for project terminal access",
  url: $("deviceLink").value,
}));
$("modeSwitch").addEventListener("click", (event) => {
  const button = event.target.closest("[data-terminal-mode]");
  if (!button || button.disabled) { return; }
  selectTerminalMode(button.dataset.terminalMode).catch((error) => {
    $("terminalStatus").textContent = error.message;
  });
});
$("reconnect").addEventListener("click", () => connectTerminal().catch((error) => { $("terminalStatus").textContent = error.message; }));
window.addEventListener("beforeunload", () => { stopScanner(); try { socket?.close(1000, "page closed"); } catch {} });

initialize();
