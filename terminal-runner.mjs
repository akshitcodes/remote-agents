import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_JOBS = 20;

function terminalError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function resolveWorkingDirectory(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw terminalError("an absolute project directory is required", "invalid_terminal_cwd");
  }

  let cwd;
  try {
    cwd = realpathSync(value);
  } catch {
    throw terminalError("the project directory no longer exists", "invalid_terminal_cwd");
  }

  if (!statSync(cwd).isDirectory()) {
    throw terminalError("the terminal working directory is not a folder", "invalid_terminal_cwd");
  }

  return cwd;
}

function shellCommand(command) {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-Command", command] };
  }

  return { file: process.platform === "darwin" ? "/bin/zsh" : "/bin/bash", args: ["-lc", command] };
}

export class TerminalRunner {
  constructor({ maxOutput = DEFAULT_MAX_OUTPUT, timeoutMs = DEFAULT_TIMEOUT_MS, maxJobs = DEFAULT_MAX_JOBS, spawnImpl = spawn } = {}) {
    this.maxOutput = maxOutput;
    this.timeoutMs = timeoutMs;
    this.maxJobs = maxJobs;
    this.spawnImpl = spawnImpl;
    this.jobs = new Map();
  }

  prune() {
    const finished = [...this.jobs.values()]
      .filter((job) => job.state !== "running")
      .sort((a, b) => a.finishedAt - b.finishedAt);

    while (this.jobs.size >= this.maxJobs && finished.length) {
      this.jobs.delete(finished.shift().id);
    }

    if (this.jobs.size >= this.maxJobs) {
      throw terminalError("too many terminal commands are already running", "terminal_busy", 409);
    }
  }

  append(job, chunk) {
    if (!chunk) { return; }
    job.output += String(chunk);

    if (job.output.length > this.maxOutput) {
      const removed = job.output.length - this.maxOutput;
      job.output = job.output.slice(removed);
      job.baseOffset += removed;
      job.truncated = true;
    }
  }

  start({ cwd: requestedCwd, command } = {}) {
    const cwd = resolveWorkingDirectory(requestedCwd);
    const text = String(command ?? "").trim();

    if (!text) { throw terminalError("command required", "terminal_command_required"); }
    if (text.length > 16_384) { throw terminalError("command is too long", "terminal_command_too_long"); }

    this.prune();
    const id = randomBytes(12).toString("hex");
    const shell = shellCommand(text);
    const child = this.spawnImpl(shell.file, shell.args, {
      cwd,
      env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const job = {
      id,
      cwd,
      command: text,
      child,
      output: "",
      baseOffset: 0,
      truncated: false,
      state: "running",
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      finishedAt: null,
      timer: null,
    };
    this.jobs.set(id, job);

    child.stdout?.on("data", (chunk) => this.append(job, chunk));
    child.stderr?.on("data", (chunk) => this.append(job, chunk));
    child.on("error", (error) => {
      this.append(job, `\n${error.message}\n`);
      this.finish(job, { state: "failed", exitCode: null });
    });
    child.on("exit", (code, signal) => {
      this.finish(job, {
        state: job.state === "stopping" ? "stopped" : (code === 0 ? "completed" : "failed"),
        exitCode: code,
        signal,
      });
    });
    job.timer = setTimeout(() => {
      if (job.state !== "running") { return; }
      job.state = "stopping";
      this.append(job, "\n[command timed out]\n");
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode == null && child.kill("SIGKILL"), 2000).unref?.();
    }, this.timeoutMs);
    job.timer.unref?.();

    return this.publicJob(job, 0);
  }

  finish(job, { state, exitCode = null, signal = null } = {}) {
    if (!job || !["running", "stopping"].includes(job.state)) { return; }
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    job.state = state;
    job.exitCode = exitCode;
    job.signal = signal;
    job.finishedAt = Date.now();
  }

  get(id, offset = 0) {
    const job = this.jobs.get(String(id ?? ""));
    if (!job) { throw terminalError("terminal command not found", "terminal_job_not_found", 404); }
    return this.publicJob(job, offset);
  }

  stop(id) {
    const job = this.jobs.get(String(id ?? ""));
    if (!job) { throw terminalError("terminal command not found", "terminal_job_not_found", 404); }
    if (job.state !== "running") { return this.publicJob(job, job.baseOffset + job.output.length); }
    job.state = "stopping";
    this.append(job, "\n[stopping]\n");
    job.child.kill("SIGTERM");
    setTimeout(() => job.child.exitCode == null && job.child.kill("SIGKILL"), 2000).unref?.();
    return this.publicJob(job, job.baseOffset + job.output.length);
  }

  publicJob(job, requestedOffset = 0) {
    const offset = Math.max(Number(requestedOffset) || 0, job.baseOffset);
    const localOffset = Math.max(0, offset - job.baseOffset);
    return {
      id: job.id,
      cwd: job.cwd,
      command: job.command,
      state: job.state,
      exitCode: job.exitCode,
      signal: job.signal,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      output: job.output.slice(localOffset),
      nextOffset: job.baseOffset + job.output.length,
      truncated: job.truncated || requestedOffset < job.baseOffset,
    };
  }
}

