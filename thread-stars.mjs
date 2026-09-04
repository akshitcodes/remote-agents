import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Starred sessions pin to the top of every list view. The cap is deliberately
// small: pinning is only useful while the pinned block stays scannable, and a
// bounded list also bounds the by-id hydration the recent view has to do when a
// starred session has aged out of its first page.
export const MAX_STARS = 10;

function key(provider, threadId) {
  return `${provider || "codex"}\n${threadId}`;
}

function cleanStar(star) {
  if (!star?.threadId) { return null; }

  return {
    provider: String(star.provider || "codex"),
    threadId: String(star.threadId),
    createdAt: Number(star.createdAt) || Date.now(),
  };
}

export class ThreadStars {
  constructor({ file } = {}) {
    this.file = file || null;
    this.stars = new Map();
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) { return; }

    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));

      for (const raw of parsed?.stars ?? []) {
        const star = cleanStar(raw);
        if (star) { this.stars.set(key(star.provider, star.threadId), star); }
      }
    } catch {
      // A damaged preference file must not prevent the bridge from starting.
    }
  }

  save() {
    if (!this.file) { return; }

    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, stars: [...this.stars.values()] }, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  // Refuses the overflow rather than evicting the oldest star. Silently dropping
  // something the user explicitly marked is worse than making them choose.
  set({ provider = "codex", threadId, starred = true } = {}) {
    if (!threadId) {
      throw Object.assign(new Error("threadId is required"), { status: 400 });
    }

    const k = key(String(provider), String(threadId));

    if (!starred) {
      if (this.stars.delete(k)) { this.save(); }
      return this.list();
    }

    if (!this.stars.has(k)) {
      if (this.stars.size >= MAX_STARS) {
        throw Object.assign(new Error(`you can star up to ${MAX_STARS} sessions; unstar one first`), {
          status: 409,
          code: "star_limit_reached",
        });
      }

      this.stars.set(k, { provider: String(provider), threadId: String(threadId), createdAt: Date.now() });
      this.save();
    }

    return this.list();
  }

  has(provider, threadId) {
    return this.stars.has(key(String(provider || "codex"), String(threadId ?? "")));
  }

  list() {
    return [...this.stars.values()]
      .sort((a, b) => a.createdAt - b.createdAt || `${a.provider}:${a.threadId}`.localeCompare(`${b.provider}:${b.threadId}`))
      .map(({ provider, threadId, createdAt }) => ({ provider, threadId, createdAt }));
  }
}
