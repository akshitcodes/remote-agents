import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const MAX_ENTRIES = 2000;
const REVERSE_CHUNK_BYTES = 512 * 1024;
const MAX_CROSSED_RECORD_BYTES = 16 * 1024 * 1024;

export const PROVIDER_MODE_KEYS = {
  codex: new Set(["read-only", "auto", "full"]),
  claude: new Set(["manual", "auto", "acceptEdits", "plan", "bypass"]),
  grok: new Set(["bypass"]),
};

export function isKnownMode(provider, mode) {
  return PROVIDER_MODE_KEYS[provider]?.has(mode) ?? false;
}

function sandboxType(value) {
  if (typeof value === "string") {
    try { return sandboxType(JSON.parse(value)); } catch { return value; }
  }

  return value && typeof value === "object" ? value.type ?? null : null;
}

function sandboxValue(value) {
  if (typeof value !== "string") { return value ?? null; }
  try { return JSON.parse(value); } catch { return value || null; }
}

// Only exact pairs represented by the existing UI presets are mapped. A mixed
// pair is authoritative but unknown, rather than being silently approximated.
export function codexModeKey(approvalMode, sandboxPolicy) {
  const sandbox = sandboxType(sandboxPolicy);

  if (approvalMode === "never" && (sandbox === "disabled" || sandbox === "danger-full-access")) {
    return "full";
  }

  if (approvalMode === "on-request" && sandbox === "workspace-write") {
    return "auto";
  }

  if (approvalMode === "untrusted" && sandbox === "read-only") {
    return "read-only";
  }

  return null;
}

export function claudeModeKey(permissionMode) {
  switch (permissionMode) {
    case "default":
    case "manual":
      return "manual";
    case "auto":
      return "auto";
    case "acceptEdits":
      return "acceptEdits";
    case "plan":
      return "plan";
    case "bypassPermissions":
      return "bypass";
    default:
      return null;
  }
}

function cleanValue(value) {
  if (value == null) { return null; }
  const text = String(value).trim();
  return text && text.length <= 200 ? text : null;
}

function immutableDbUrl(path) {
  const url = pathToFileURL(path);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return url;
}

export function findCodexStateDb(codexHome = join(homedir(), ".codex")) {
  const dir = join(codexHome, "sqlite");

  try {
    const files = readdirSync(dir).filter((name) => /^state_(\d+)\.sqlite$/.test(name));
    files.sort((a, b) => Number(/(\d+)/.exec(b)[1]) - Number(/(\d+)/.exec(a)[1]));
    return files.length ? join(dir, files[0]) : null;
  } catch {
    return null;
  }
}

export function readCodexDbThreadSettings(threadId, { dbPath = findCodexStateDb() } = {}) {
  if (!threadId || !dbPath || !existsSync(dbPath)) { return null; }

  let db;

  try {
    db = new DatabaseSync(immutableDbUrl(dbPath), { readOnly: true });
    const row = db.prepare(`
      SELECT model, reasoning_effort, approval_mode, sandbox_policy
      FROM threads
      WHERE id = ?
    `).get(threadId);

    if (!row) { return null; }

    const approval = cleanValue(row.approval_mode);
    const sandboxPolicy = sandboxValue(row.sandbox_policy);
    const sandbox = sandboxType(sandboxPolicy);
    const modeExposed = approval != null || sandbox != null;

    return {
      model: cleanValue(row.model),
      effort: cleanValue(row.reasoning_effort),
      mode: modeExposed ? codexModeKey(approval, sandbox) : null,
      modeExposed,
      approvalPolicy: approval,
      sandboxPolicy,
      source: "codex_db",
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

// Visit complete JSONL records newest-first without reading a whole transcript.
// Settings records are small; if one preceding record alone exceeds 16 MB, stop
// rather than letting a damaged/compacted record grow memory without bound.
function scanJsonRecordsReverse(path, visit) {
  let fd;

  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    let position = size;
    let carry = "";

    while (position > 0) {
      const start = Math.max(0, position - REVERSE_CHUNK_BYTES);
      const length = position - start;
      const buf = Buffer.allocUnsafe(length);
      readSync(fd, buf, 0, length, start);
      const parts = (buf.toString("utf8") + carry).split("\n");
      carry = parts.shift() ?? "";

      for (let i = parts.length - 1; i >= 0; i--) {
        if (!parts[i].trim()) { continue; }
        let row;
        try { row = JSON.parse(parts[i]); } catch { continue; }
        if (visit(row)) { return true; }
      }

      if (carry.length > MAX_CROSSED_RECORD_BYTES) { return false; }
      position = start;
    }

    if (carry.trim()) {
      try { return !!visit(JSON.parse(carry)); } catch {}
    }
  } catch {
    return false;
  } finally {
    try { if (fd !== undefined) { closeSync(fd); } } catch {}
  }

  return false;
}

function codexRolloutRecordSettings(row) {
  if (row?.type === "event_msg" && row.payload?.type === "thread_settings_applied") {
    const settings = row.payload.thread_settings ?? {};
    const approval = cleanValue(settings.approval_policy);
    const sandbox = settings.permission_profile ?? settings.sandbox_policy;
    const exposed = approval != null || sandboxType(sandbox) != null;
    return {
      model: cleanValue(settings.model),
      effort: cleanValue(settings.reasoning_effort),
      mode: exposed ? codexModeKey(approval, sandbox) : null,
      modeExposed: exposed,
      source: "codex_rollout",
    };
  }

  if (row?.type === "turn_context") {
    const settings = row.payload ?? {};
    const approval = cleanValue(settings.approval_policy);
    const sandbox = settings.sandbox_policy ?? settings.permission_profile;
    const exposed = approval != null || sandboxType(sandbox) != null;
    return {
      model: cleanValue(settings.model),
      effort: cleanValue(settings.effort ?? settings.reasoning_effort),
      mode: exposed ? codexModeKey(approval, sandbox) : null,
      modeExposed: exposed,
      source: "codex_rollout",
    };
  }

  return null;
}

export function readCodexRolloutThreadSettings(path) {
  if (!path || !existsSync(path)) { return null; }
  let found = null;
  scanJsonRecordsReverse(path, (row) => {
    found = codexRolloutRecordSettings(row);
    return !!found;
  });
  return found;
}

export function readClaudeTranscriptThreadSettings(path) {
  if (!path || !existsSync(path)) { return null; }
  let model = null;
  let effort = null;
  let permission = null;
  let foundAssistantSettings = false;

  scanJsonRecordsReverse(path, (row) => {
    if (permission == null) { permission = cleanValue(row?.permissionMode); }

    if (!foundAssistantSettings && row?.type === "assistant" && row.message) {
      const candidate = cleanValue(row.message.model);
      if (candidate && candidate !== "<synthetic>") {
        model = candidate;
        effort = cleanValue(row.effort);
        foundAssistantSettings = true;
      }
    }

    return foundAssistantSettings && permission != null;
  });

  if (model == null && effort == null && permission == null) { return null; }

  return {
    model,
    effort,
    mode: permission == null ? null : claudeModeKey(permission),
    modeExposed: permission != null,
    source: "claude_transcript",
  };
}

export function readGrokSessionThreadSettings(session) {
  if (!session) { return null; }
  let model = null;
  let effort = null;

  if (session.summaryPath && existsSync(session.summaryPath)) {
    try {
      const summary = JSON.parse(readFileSync(session.summaryPath, "utf8"));
      model = cleanValue(summary.current_model_id);
      effort = cleanValue(summary.reasoning_effort);
    } catch {}
  }

  if ((!model || !effort) && session.historyPath && existsSync(session.historyPath)) {
    scanJsonRecordsReverse(session.historyPath, (row) => {
      if (!model) { model = cleanValue(row?.model_id); }
      if (!effort) { effort = cleanValue(row?.reasoning_effort); }
      return !!model && !!effort;
    });
  }

  if (!model && !effort) { return null; }

  // sandbox_profile is deliberately not treated as Manual/Bypass: it does not
  // record Grok's approval behavior, and the transcript has no such field.
  return { model, effort, mode: null, modeExposed: false, source: "grok_session" };
}

export class ThreadSettingsStore {
  constructor({ file, now = () => Date.now() } = {}) {
    if (!file) { throw new Error("thread settings file required"); }
    this.file = file;
    this.now = now;
    this.entries = new Map();
    this.load();
  }

  key(provider, threadId) {
    return `${provider}:${threadId}`;
  }

  load() {
    let rows;
    try { rows = JSON.parse(readFileSync(this.file, "utf8")); } catch { return; }
    if (!Array.isArray(rows)) { return; }

    for (const row of rows) {
      if (!row?.provider || !row?.threadId) { continue; }
      this.entries.set(this.key(row.provider, row.threadId), {
        provider: row.provider,
        threadId: row.threadId,
        model: cleanValue(row.model),
        effort: cleanValue(row.effort),
        mode: isKnownMode(row.provider, row.mode) ? row.mode : null,
        pending: {
          model: !!row.pending?.model,
          effort: !!row.pending?.effort,
          mode: !!row.pending?.mode,
        },
        updatedAt: Number(row.updatedAt) || 0,
      });
    }
  }

  get(provider, threadId) {
    return this.entries.get(this.key(provider, threadId)) ?? null;
  }

  set(provider, threadId, patch = {}, { pending = false } = {}) {
    if (!PROVIDER_MODE_KEYS[provider] || !cleanValue(threadId)) {
      throw Object.assign(new Error("invalid provider or threadId"), { status: 400 });
    }

    if (patch.mode != null && !isKnownMode(provider, patch.mode)) {
      throw Object.assign(new Error("invalid permission mode"), { status: 400 });
    }

    const previous = this.get(provider, threadId) ?? {
      provider, threadId, model: null, effort: null, mode: null,
      pending: { model: false, effort: false, mode: false },
    };
    const pendingFields = { ...(previous.pending ?? {}) };
    for (const field of ["model", "effort", "mode"]) {
      if (patch[field] !== undefined) { pendingFields[field] = !!pending; }
    }
    const next = {
      ...previous,
      ...(patch.model !== undefined ? { model: cleanValue(patch.model) } : {}),
      ...(patch.effort !== undefined ? { effort: cleanValue(patch.effort) } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode == null ? null : patch.mode } : {}),
      pending: pendingFields,
      updatedAt: this.now(),
    };
    this.entries.set(this.key(provider, threadId), next);
    this.persist();
    return next;
  }

  adopt(provider, fromThreadId, toThreadId) {
    const from = this.get(provider, fromThreadId);
    if (!from || !cleanValue(toThreadId)) { return null; }
    const next = { ...from, threadId: toThreadId, updatedAt: this.now() };
    this.entries.delete(this.key(provider, fromThreadId));
    this.entries.set(this.key(provider, toThreadId), next);
    this.persist();
    return next;
  }

  persist() {
    let rows = [...this.entries.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    if (rows.length > MAX_ENTRIES) {
      rows = rows.slice(-MAX_ENTRIES);
      this.entries = new Map(rows.map((row) => [this.key(row.provider, row.threadId), row]));
    }

    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export class ThreadSettingsService {
  constructor({ store, readers = {} } = {}) {
    if (!store) { throw new Error("thread settings store required"); }
    this.store = store;
    this.readers = readers;
  }

  async resolve(provider, threadId, { models = null } = {}) {
    const authoritative = await this.readers[provider]?.(threadId) ?? null;
    const stored = this.store.get(provider, threadId);
    const modelFromProvider = authoritative?.model != null;
    const effortFromProvider = authoritative?.effort != null;
    const modeFromProvider = authoritative?.modeExposed === true;
    const modelOverride = !!stored?.pending?.model && stored.model != null;
    const effortOverride = !!stored?.pending?.effort && stored.effort != null;
    const modeOverride = !!stored?.pending?.mode && stored.mode != null;
    const model = modelOverride ? stored.model : (modelFromProvider ? authoritative.model : stored?.model ?? null);
    const effort = effortOverride ? stored.effort : (effortFromProvider ? authoritative.effort : stored?.effort ?? null);
    const mode = modeOverride ? stored.mode : (modeFromProvider ? authoritative.mode : stored?.mode ?? null);
    const sources = {
      model: modelOverride ? "bridge_override" : (modelFromProvider ? authoritative.source : (stored?.model ? "bridge_store" : null)),
      effort: effortOverride ? "bridge_override" : (effortFromProvider ? authoritative.source : (stored?.effort ? "bridge_store" : null)),
      mode: modeOverride ? "bridge_override" : (modeFromProvider ? authoritative.source : (stored?.mode ? "bridge_store" : null)),
    };

    return {
      provider,
      threadId,
      model,
      effort,
      mode,
      modeKnown: modeOverride ? true : (modeFromProvider ? mode != null : true),
      // Codex's managed policy cannot be represented by one of our three
      // presets. Preserve the provider-owned pair so the client can show and
      // dispatch it exactly instead of replacing it with a broader preset.
      approvalPolicy: authoritative?.approvalPolicy ?? null,
      sandboxPolicy: authoritative?.sandboxPolicy ?? null,
      modelAvailability: model == null
        ? null
        : (Array.isArray(models) ? (models.some((item) => item?.id === model) ? "listed" : "unlisted") : "unknown"),
      sources,
      providerConfirmed: authoritative ? {
        model: authoritative.model ?? null,
        effort: authoritative.effort ?? null,
        mode: authoritative.mode ?? null,
        modeExposed: authoritative.modeExposed === true,
        source: authoritative.source ?? null,
      } : null,
    };
  }

  remember(provider, threadId, patch, options) {
    return this.store.set(provider, threadId, patch, options);
  }

  adopt(provider, fromThreadId, toThreadId) {
    return this.store.adopt(provider, fromThreadId, toThreadId);
  }
}
