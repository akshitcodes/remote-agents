import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Enough to cover any real machine's project list while keeping the file small
// and the "new session" screen instant. Retention prefers the folders with the
// most sessions, then the most recently used, so the cap only ever drops
// projects that are both rarely and not recently worked in.
export const MAX_PROJECTS_PER_PROVIDER = 40;

function cleanProject(project) {
  const path = String(project?.path ?? "").trim();

  if (!path) { return null; }

  return {
    path,
    name: String(project?.name || path.split(/[\\/]/).filter(Boolean).pop() || path),
    count: Number(project?.count) || 0,
    lastUsed: Number(project?.lastUsed) || 0,
  };
}

function rank(a, b) {
  return b.count - a.count || b.lastUsed - a.lastUsed || a.path.localeCompare(b.path);
}

export class ProjectStore {
  constructor({ file } = {}) {
    this.file = file || null;
    this.byProvider = new Map();
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) { return; }

    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));

      for (const [provider, projects] of Object.entries(parsed?.providers ?? {})) {
        const rows = (Array.isArray(projects) ? projects : []).map(cleanProject).filter(Boolean);
        if (rows.length) { this.byProvider.set(String(provider), rows.sort(rank).slice(0, MAX_PROJECTS_PER_PROVIDER)); }
      }
    } catch {
      // A damaged cache must not prevent the bridge from starting. Worst case
      // the new-session screen falls back to a live provider read.
    }
  }

  save() {
    if (!this.file) { return; }

    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, providers: Object.fromEntries(this.byProvider) }, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  // A provider scan is authoritative for that provider: a folder that no longer
  // has sessions should disappear rather than linger as a stale suggestion.
  // An empty scan is ignored, because "the CLI was unreachable" and "you have
  // no projects" arrive as the same empty array.
  remember(provider, projects) {
    const rows = (projects ?? []).map(cleanProject).filter(Boolean);

    if (!rows.length) { return this.list(provider); }

    const deduped = new Map();
    for (const row of rows) {
      const existing = deduped.get(row.path);
      if (!existing || rank(row, existing) < 0) { deduped.set(row.path, row); }
    }

    const kept = [...deduped.values()].sort(rank).slice(0, MAX_PROJECTS_PER_PROVIDER);
    const previous = JSON.stringify(this.byProvider.get(String(provider)) ?? []);
    this.byProvider.set(String(provider), kept);

    if (JSON.stringify(kept) !== previous) { this.save(); }

    return kept;
  }

  list(provider) {
    return this.byProvider.get(String(provider)) ?? [];
  }

  all(providers) {
    const names = providers ?? [...this.byProvider.keys()];
    return Object.fromEntries(names.map((name) => [name, this.list(name)]));
  }
}
