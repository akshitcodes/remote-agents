// Is somebody else already driving this session?
//
// Warming a CLI for a thread you merely opened is a good optimisation — the
// first send is otherwise slow — but it is only safe when nothing else owns that
// session. Attaching a second controller to a session that is live in a terminal
// or the VS Code extension puts two writers on one transcript, and the warmed
// process carries an approval hook, so the *original* session's tool calls end
// up waiting on an approval nobody knows to give.
//
// A holder is directly observable: `claude --resume <id>` and friends carry the
// session id in their command line. Anything we spawned ourselves is our own
// child, so it is excluded by parent pid.

import { execFileSync } from "node:child_process";

const TTL_MS = 2000;
let cache = { at: 0, lines: [] };

function processLines() {
  if (Date.now() - cache.at < TTL_MS) {
    return cache.lines;
  }

  let lines = [];

  try {
    const out = execFileSync("ps", ["-ax", "-o", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    lines = out.split("\n");
  } catch {
    // If we cannot tell, the caller treats that as "held" and skips warming —
    // losing an optimisation is cheaper than corrupting someone's session.
    lines = null;
  }

  cache = { at: Date.now(), lines };
  return lines;
}

export function sessionHeldElsewhere(sessionId, { ownPid = process.pid } = {}) {
  if (!sessionId) {
    return false;
  }

  const lines = processLines();

  // Unknown means unsafe.
  if (lines === null) {
    return true;
  }

  for (const line of lines) {
    if (!line.includes(sessionId)) {
      continue;
    }

    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);

    if (!m) {
      continue;
    }

    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const cmd = m[3];

    // Ours, or us.
    if (pid === ownPid || ppid === ownPid) {
      continue;
    }

    // Only an agent CLI can hold a session. Plenty of unrelated processes
    // mention a session id in passing — an HTTP request carrying it in the
    // query string, a log tail, an editor — and counting those would refuse to
    // warm anything. This caught itself in testing: the curl issuing the read
    // was matching its own URL.
    if (!/(^|\/)(claude|node)\b/.test(cmd) || !/claude/.test(cmd)) {
      continue;
    }

    // The holder runs the session; a command that merely names it (a grep, a
    // curl, an editor opening the transcript) does not.
    if (!/--resume\b|--session-id\b|--continue\b/.test(cmd)) {
      continue;
    }

    return true;
  }

  return false;
}
