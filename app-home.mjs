import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Tests and smoke servers can isolate all bridge-owned state without moving the
// provider homes. In production this remains ~/.codex-phone.
export function remoteAgentsHome() {
  const override = String(process.env.REMOTE_AGENTS_HOME ?? "").trim();
  return override ? resolve(override) : join(homedir(), ".codex-phone");
}
