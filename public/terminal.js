import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/xterm-addon-fit.mjs";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const provider = params.get("provider") || "codex";
const threadId = params.get("threadId") || "";
let enrollmentCapability = new URLSearchParams(location.hash.slice(1)).get("enroll") || "";
if (enrollmentCapability) { history.replaceState(null, "", location.pathname + location.search); }

let socket = null;
let terminal = null;
let fitAddon = null;
let resizeObserver = null;
let inputSequence = 0;
let fallbackJob = null;

function setError(message = "") {
  $("gateError").textContent = message;
  $("gateError").classList.toggle("hidden", !message);
}

function gate({ title, copy, action, disabled = false, code = false, label = false, onclick = null }) {
  $("gate").classList.remove("hidden");
  $("terminalShell").classList.add("hidden");
  $("fallback").classList.add("hidden");
  $("gateTitle").textContent = title;
  $("gateCopy").textContent = copy;
  $("codeField").classList.toggle("hidden", !code);
  $("labelField").classList.toggle("hidden", !label);
  $("gateAction").textContent = action;
  $("gateAction").disabled = disabled;
  $("gateAction").onclick = onclick;
  $("connection").textContent = "Locked";
  $("connection").classList.remove("live");
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
    if (!status.access.enabled) {
      return gate({ title: "Terminal access is off", copy: "On the bridge computer, run: remote-agents terminal enable. Then scan its QR code or enter the one-time code here.", action: "Check again", onclick: initialize });
    }
    if (!status.access.enrolled || enrollmentCapability) {
      $("deviceLabel").value ||= deviceLabel();
      return gate({ title: "Trust this device", copy: "Enter the one-time code created locally, then create a passkey with Face ID, Touch ID, Windows Hello, or your device PIN.", action: "Create passkey", code: !enrollmentCapability, label: true, onclick: register });
    }
    if (!status.access.unlocked) {
      return gate({ title: "Unlock project terminal", copy: `Verify the passkey for ${status.access.device?.label || "this device"}. The unlock expires after inactivity.`, action: "Unlock with passkey", onclick: unlock });
    }
    if (!status.backend.available) {
      $("context").textContent = `${provider} · project command mode`;
      $("gate").classList.add("hidden");
      $("terminalShell").classList.add("hidden");
      $("fallback").classList.remove("hidden");
      $("fallbackReason").textContent = status.backend.reason || "Interactive PTY is unavailable on this machine.";
      $("connection").textContent = "Command mode";
      return;
    }
    await connectTerminal();
  } catch (error) {
    gate({ title: "Terminal unavailable", copy: "The bridge could not establish secure terminal access.", action: "Try again", onclick: initialize });
    setError(error.message);
  }
}

$("commandForm").addEventListener("submit", runFallback);
$("reconnect").addEventListener("click", () => connectTerminal().catch((error) => { $("terminalStatus").textContent = error.message; }));
window.addEventListener("beforeunload", () => { try { socket?.close(1000, "page closed"); } catch {} });

initialize();
